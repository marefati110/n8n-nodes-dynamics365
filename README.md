# n8n-nodes-dynamics365

n8n community nodes for **Microsoft Dynamics 365 / Dataverse on-premises** (CRM 9.x), using the Web API with **NTLM (Windows) authentication**.

The package has no runtime dependencies. NTLMv2 (including MD4) is implemented in the package itself, because n8n's HTTP helpers do not support NTLM.

The nodes don't hard-code any tables or messages. Tables, columns, option sets, relationships, views, workflows, and all **actions and functions** are read from the server's metadata at runtime. Custom tables and custom actions work with no extra setup.

Tested against Dynamics 365 9.1.12.17 on-premises with n8n 2.36.7.

## Nodes

| Node | Purpose |
| --- | --- |
| **Dynamics 365 (On-Premises)** | Records, actions/functions, metadata, `$batch`, raw requests. Also available as an AI agent tool. |
| **Dynamics 365 (On-Premises) Trigger** | Polling trigger for created and/or updated records. |

### Resources and operations

**Record**
- Create, Update, Upsert (create-or-update, create-only, update-only), Delete, Get, Get Many
- Query (FetchXML): automatic paging cookie handling. Very long queries are sent through `$batch` to avoid URL length limits.
- Get View Records: system (`savedQuery`) or personal (`userQuery`) views
- Get Related: navigate any 1:N, N:1 or N:N relationship
- Associate / Disassociate: collection-valued and single-valued navigation properties
- Assign (user/team), Set State (statecode/statuscode)
- Get / Set / Clear Field Value
- Download / Upload File or Image (image columns such as `entityimage`)
- Count: exact count, optionally filtered

**Action / Function**
- Execute Action: any of the ~2000 system and custom actions, unbound, bound to a record, or bound to a table
- Execute Function: any function, with OData parameter aliases built automatically
- Run Workflow: on-demand (classic) workflows via `ExecuteWorkflow`

Parameters are shown as typed fields based on the CSDL (booleans, numbers, dates, enum dropdowns, record references, collections, complex types), or can be passed as JSON.

**Metadata**: list tables, get a table definition, list columns, list relationships, get option sets (column or global), list global option sets, list/get actions and functions, clear the metadata cache.

**Batch**: send many requests in one `$batch` call, optionally in an atomic change set, with continue-on-error. Each response is mapped back to its input item.

**Custom API Call**: any method and path against the Web API with the NTLM credentials. Supports JSON, raw or binary bodies, binary responses, and following `@odata.nextLink`.

### Common options

- **Annotations**: formatted values (option set labels, lookup names, formatted money and dates) or all annotations
- **Impersonate User ID**: sent as `MSCRMCallerID`
- **Enable Duplicate Detection**, **Bypass Custom Plugins**
- **Timeout**

## Installation

Build a tarball:

```bash
npm install
npm run build
npm pack          # creates n8n-nodes-dynamics365-0.1.0.tgz
```

Then install it into n8n's community nodes folder, for example in a Docker image:

```dockerfile
FROM registry.ahanoffline.ir/n8n:2.36.7-ce.1
COPY n8n-nodes-dynamics365-0.1.0.tgz /tmp/
RUN mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes \
 && npm install /tmp/n8n-nodes-dynamics365-0.1.0.tgz
```

Or on a plain installation:

```bash
cd ~/.n8n/nodes && npm install /path/to/n8n-nodes-dynamics365-0.1.0.tgz
```

Restart n8n afterwards. The `n8n-workflow` package is a peer dependency provided by n8n itself.

## Credentials

Create **Dynamics 365 On-Premises (NTLM) API** credentials:

| Field | Example |
| --- | --- |
| Organization URL | `http://172.16.25.70/ahanonlinedev`. A full `…/api/data/v9.1` URL also works. |
| API Version | `9.1` |
| Username | `crmadmin`, `DOMAIN\crmadmin` or `crmadmin@domain` |
| Password | |
| Domain | optional; defaults to the domain in the username or the one announced by the server |

The **Test** button calls `WhoAmI()`.

The server must offer NTLM, either directly or through `Negotiate`. Kerberos-only servers are not supported.

## Value formats

**Lookup columns** (Create / Update / Upsert, *Map Columns* mode) accept:

- a GUID: `5e80e09c-b131-e911-8148-000c29f57f53` (single-table lookups; `Owner` defaults to `systemuser`)
- `table:GUID`: `account:5e80…`
- `entityset(GUID)`: `accounts(5e80…)` or `/accounts(5e80…)`
- `null` to clear the lookup

The node turns these into the right `navigationproperty@odata.bind` reference. For multi-table lookups such as `parentcustomerid` or `regardingobjectid`, it picks the navigation property for the referenced table. Clearing is done with `DELETE …/$ref`, because 9.x rejects a null `@odata.bind`.

In *JSON* mode the body is sent as-is, except that `"nav@odata.bind": null` is also converted into a `DELETE …/$ref`.

**Record parameters of actions and functions** (for example `Target`) accept the same notations, or a full JSON object such as `{"@odata.type": "Microsoft.Dynamics.CRM.account", "accountid": "…"}`. Collection parameters accept a JSON array or a comma-separated list.

Examples:

- **Execute Action → GrantAccess**
  - `Target`: `contact:<id>`
  - `PrincipalAccess`: `{"Principal": {"@odata.type": "Microsoft.Dynamics.CRM.team", "teamid": "<id>"}, "AccessMask": "ReadAccess"}`
- **Execute Function → RetrieveTotalRecordCount**
  - `EntityNames`: `account,contact`

## Trigger

The trigger polls on `createdon` (created) or `modifiedon` (updated / created or updated):

- On activation it starts from "now".
- On a manual test it returns the most recent record.
- Records with identical timestamps are not emitted twice.

You can add an extra OData filter and limit the selected columns.

## Metadata cache

Table, column, relationship, and CSDL metadata are cached in memory for 30–60 minutes per credential. After customizing the CRM, run **Metadata → Clear Cache**, or restart n8n.

The first action/function lookup downloads `$metadata`, which is about 13 MB on a typical organization, and takes a few seconds.

## Development

```bash
npm install
npm run build
npm test                    # offline unit tests (NTLM vectors, CSDL, OData helpers, batch)

# Live tests (read-only unless DYNAMICS_TEST_WRITE=1)
DYNAMICS_URL=http://server/org DYNAMICS_USERNAME=user DYNAMICS_PASSWORD=secret \
  npm run test:integration

# Include write tests; supply the columns your org requires
DYNAMICS_TEST_WRITE=1 DYNAMICS_TEST_RECORD='{"lastname":"n8n-node-test","new_type":100000005}' \
  DYNAMICS_URL=… DYNAMICS_USERNAME=… DYNAMICS_PASSWORD=… npm run test:integration
```

Source layout:

```
credentials/                         NTLM credential type
nodes/Dynamics365/
  transport/ntlm.ts                  NTLMv2 + MD4
  transport/httpClient.ts            keep-alive connection pool with NTLM handshake
  transport/index.ts                 Web API requests, errors, paging, cache
  helpers/csdl.ts                    $metadata parser (actions, functions, enums)
  helpers/metadata.ts                EntityDefinitions: tables, columns, option sets, relationships
  helpers/odata.ts                   keys, lookups, parameter literals, $batch, FetchXML paging
  methods/                           dropdowns, field mappers, credential test
  descriptions/                      UI definitions per resource
  actions/                           execution per resource
nodes/Dynamics365Trigger/            polling trigger
```

## Limitations

- **HTTP proxies** are not supported. The node connects directly to the CRM server.
- **File columns** larger than one request (chunked upload) are not implemented. 9.1 on-premises does not have file columns; image columns work.
- **FetchXML aggregates** are limited by the server to 50,000 records (`AggregateQueryRecordLimit`). The *Count* operation falls back to paging in that case.

## License

MIT
