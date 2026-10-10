'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ntlm = require('../dist/nodes/Dynamics365/transport/ntlm');
const { buildConnection, buildQueryString } = require('../dist/nodes/Dynamics365/transport');
const { parseCsdl, findOperation } = require('../dist/nodes/Dynamics365/helpers/csdl');
const odata = require('../dist/nodes/Dynamics365/helpers/odata');

test('MD4 matches RFC 1320 test vectors', () => {
	const vectors = {
		'': '31d6cfe0d16ae931b73c59d7e0c089c0',
		a: 'bde52cb31de33e46245e05fbdbd6fb24',
		abc: 'a448017aaf21d8525fc10ae87aa6729d',
		'message digest': 'd9130a8164549fe818874806e1c7014b',
		'12345678901234567890123456789012345678901234567890123456789012345678901234567890':
			'e33b4ddc9c38f2199c3e7b164fcc0536',
	};
	for (const [input, expected] of Object.entries(vectors)) {
		assert.equal(ntlm.md4(Buffer.from(input)).toString('hex'), expected, input);
	}
});

test('NT and NTLMv2 hashes match MS-NLMP 4.2', () => {
	assert.equal(ntlm.ntHash('Password').toString('hex'), 'a4f49c406510bdcab6824ee7c30fd852');
	assert.equal(ntlm.ntlmv2Hash('User', 'Password', 'Domain').toString('hex'), '0c868a403bfd7a93a3001ef22ef02e3f');
});

test('identity normalization splits DOMAIN\\user and user@domain', () => {
	assert.deepEqual(ntlm.normalizeIdentity({ username: 'CORP\\bob', password: 'x' }).domain, 'CORP');
	assert.deepEqual(ntlm.normalizeIdentity({ username: 'bob@corp.local', password: 'x' }).username, 'bob');
	assert.equal(ntlm.normalizeIdentity({ username: 'CORP\\bob', password: 'x', domain: 'OTHER' }).domain, 'OTHER');
});

test('type 1 message has NTLMSSP signature and type 1', () => {
	const message = Buffer.from(ntlm.createType1Message(), 'base64');
	assert.equal(message.subarray(0, 8).toString('latin1'), 'NTLMSSP\0');
	assert.equal(message.readUInt32LE(8), 1);
});

test('type 2 parsing and type 3 generation', () => {
	// Build a challenge with target name "DOM" and an empty target info block.
	const targetName = Buffer.from('DOM', 'utf16le');
	const targetInfo = Buffer.from([0x02, 0x00, 0x06, 0x00, ...Buffer.from('DOM', 'utf16le'), 0x00, 0x00, 0x00, 0x00]);
	const header = Buffer.alloc(48);
	header.write('NTLMSSP\0', 0, 'latin1');
	header.writeUInt32LE(2, 8);
	header.writeUInt16LE(targetName.length, 12);
	header.writeUInt16LE(targetName.length, 14);
	header.writeUInt32LE(48, 16);
	header.writeUInt32LE(0x00808201, 20);
	Buffer.from('0123456789abcdef', 'hex').copy(header, 24);
	header.writeUInt16LE(targetInfo.length, 40);
	header.writeUInt16LE(targetInfo.length, 42);
	header.writeUInt32LE(48 + targetName.length, 44);
	const type2 = Buffer.concat([header, targetName, targetInfo]).toString('base64');

	const challenge = ntlm.parseType2Message(type2);
	assert.equal(challenge.targetName, 'DOM');
	assert.equal(challenge.serverChallenge.toString('hex'), '0123456789abcdef');
	assert.deepEqual(challenge.targetInfo, targetInfo);

	const type3 = Buffer.from(
		ntlm.createType3Message(challenge, { username: 'user', password: 'pass' }, {
			clientNonce: Buffer.alloc(8, 0xaa),
			timestamp: Buffer.alloc(8),
		}),
		'base64',
	);
	assert.equal(type3.readUInt32LE(8), 3);
	const read = (offset) => type3.subarray(type3.readUInt32LE(offset + 4), type3.readUInt32LE(offset + 4) + type3.readUInt16LE(offset));
	assert.equal(read(28).toString('utf16le'), 'DOM', 'falls back to server domain');
	assert.equal(read(36).toString('utf16le'), 'user');
	// NTLMv2 response = 16-byte proof + blob that embeds the client nonce and target info.
	const ntResponse = read(20);
	assert.equal(ntResponse.subarray(16, 20).toString('hex'), '01010000');
	assert.ok(ntResponse.includes(Buffer.alloc(8, 0xaa)));
	assert.ok(ntResponse.includes(targetInfo));
});

test('challenge token extraction accepts NTLM and Negotiate schemes', () => {
	const token = Buffer.concat([Buffer.from('NTLMSSP\0', 'latin1'), Buffer.alloc(8)]).toString('base64');
	assert.deepEqual(ntlm.extractChallengeToken([`Negotiate ${token}`]), { scheme: 'Negotiate', token });
	assert.deepEqual(ntlm.extractChallengeToken(`NTLM ${token}`), { scheme: 'NTLM', token });
	assert.equal(ntlm.extractChallengeToken(['Negotiate', 'NTLM']), undefined);
	assert.deepEqual(ntlm.supportedSchemes(['Negotiate', 'NTLM']), ['Negotiate', 'NTLM']);
});

test('connection URL normalization', () => {
	const base = { username: 'u', password: 'p', apiVersion: '9.1' };
	assert.equal(buildConnection({ ...base, url: 'http://crm/org/' }).baseUrl, 'http://crm/org/api/data/v9.1');
	assert.equal(buildConnection({ ...base, url: 'http://crm/org/api/data/v9.0/$metadata' }).baseUrl, 'http://crm/org/api/data/v9.1');
	assert.equal(buildConnection({ ...base, url: 'https://crm/org', apiVersion: 'v9.2' }).baseUrl, 'https://crm/org/api/data/v9.2');
});

test('query strings keep $ parameters literal and encode values', () => {
	assert.equal(
		buildQueryString({ $select: 'name,accountid', $filter: "name eq 'a&b'", empty: '', skip: undefined }),
		"?$select=name%2Caccountid&$filter=name%20eq%20'a%26b'",
	);
});

const CSDL = `<?xml version="1.0"?><edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx"><edmx:DataServices>
<Schema Namespace="Microsoft.Dynamics.CRM" Alias="mscrm" xmlns="http://docs.oasis-open.org/odata/ns/edm">
<EntityType Name="crmbaseentity" Abstract="true" />
<EntityType Name="account" BaseType="mscrm.crmbaseentity"><Key><PropertyRef Name="accountid" /></Key></EntityType>
<EntityType Name="lead" BaseType="mscrm.crmbaseentity"><Key><PropertyRef Name="leadid" /></Key></EntityType>
<ComplexType Name="PrincipalAccess"><Property Name="AccessMask" Type="mscrm.AccessRights" /></ComplexType>
<EnumType Name="EntityFilters" IsFlags="true"><Member Name="Entity" Value="1" /><Member Name="Attributes" Value="2" /></EnumType>
<EnumType Name="TargetFieldType"><Member Name="All" Value="0" /><Member Name="ValidForCreate" Value="1" /></EnumType>
<Action Name="QualifyLead" IsBound="true"><Parameter Name="entity" Type="mscrm.lead" Nullable="false" /><Parameter Name="CreateAccount" Type="Edm.Boolean" Nullable="false" /><Parameter Name="SourceCampaignId" Type="mscrm.campaign" /><ReturnType Type="Collection(mscrm.crmbaseentity)" Nullable="false" /></Action>
<Action Name="GrantAccess"><Parameter Name="Target" Type="mscrm.crmbaseentity" Nullable="false" /><Parameter Name="PrincipalAccess" Type="mscrm.PrincipalAccess" Nullable="false" /></Action>
<Function Name="WhoAmI"><ReturnType Type="mscrm.WhoAmIResponse" Nullable="false" /></Function>
<Function Name="RetrieveTotalRecordCount"><Parameter Name="EntityNames" Type="Collection(Edm.String)" Nullable="false" Unicode="false" /><ReturnType Type="mscrm.RetrieveTotalRecordCountResponse" Nullable="false" /></Function>
<Function Name="InitializeFrom"><Parameter Name="EntityMoniker" Type="mscrm.crmbaseentity" Nullable="false" /><Parameter Name="TargetEntityName" Type="Edm.String" Nullable="false" /><Parameter Name="TargetFieldType" Type="mscrm.TargetFieldType" Nullable="false" /><Parameter Name="RetrieveConsumableRecord" Type="Edm.Boolean"><Annotation Term="Org.OData.Core.V1.OptionalParameter" /></Parameter><ReturnType Type="mscrm.crmbaseentity" Nullable="false" /></Function>
<Function Name="GetDefaultPriceLevel" IsBound="true"><Parameter Name="entityset" Type="Collection(mscrm.pricelevel)" Nullable="false" /><Parameter Name="EntityName" Type="Edm.String" Nullable="false" /><ReturnType Type="Collection(mscrm.pricelevel)" Nullable="false" /></Function>
<EntityContainer Name="System"><EntitySet Name="accounts" EntityType="Microsoft.Dynamics.CRM.account" /><EntitySet Name="leads" EntityType="Microsoft.Dynamics.CRM.lead" />
<ActionImport Name="GrantAccess" Action="Microsoft.Dynamics.CRM.GrantAccess" /><FunctionImport Name="WhoAmI" Function="Microsoft.Dynamics.CRM.WhoAmI" /></EntityContainer>
</Schema></edmx:DataServices></edmx:Edmx>`;

test('CSDL parsing extracts sets, enums and operations', () => {
	const model = parseCsdl(CSDL);
	assert.equal(model.entitySets.get('accounts'), 'account');
	assert.equal(model.entityTypeToSet.get('lead'), 'leads');
	assert.ok(model.complexTypes.has('PrincipalAccess'));
	assert.equal(model.enums.get('EntityFilters').isFlags, true);

	const qualify = findOperation(model, 'action', 'QualifyLead', 'entity', 'lead');
	assert.equal(qualify.bindingParameter, 'entity');
	assert.equal(qualify.boundEntity, 'lead');
	assert.deepEqual(qualify.parameters.map((p) => p.name), ['CreateAccount', 'SourceCampaignId']);
	assert.equal(qualify.parameters[0].nullable, false);
	assert.equal(qualify.returnType, 'Collection(crmbaseentity)');

	const priceLevel = findOperation(model, 'function', 'GetDefaultPriceLevel', 'collection', 'pricelevel');
	assert.equal(priceLevel.boundToCollection, true);

	const init = findOperation(model, 'function', 'InitializeFrom', 'unbound');
	assert.equal(init.parameters.find((p) => p.name === 'RetrieveConsumableRecord').optional, true);
	assert.equal(findOperation(model, 'function', 'WhoAmI', 'unbound').isImport, true);
	assert.equal(findOperation(model, 'action', 'QualifyLead', 'unbound'), undefined);
});

test('function calls use parameter aliases with OData literals', async () => {
	const model = parseCsdl(CSDL);
	const context = { getNode: () => ({ name: 'test' }) };
	const call = (name, values) =>
		odata.buildFunctionCall.call(context, model, findOperation(model, 'function', name, 'unbound'), values);

	assert.deepEqual(await call('WhoAmI', {}), { path: 'WhoAmI()', qs: {} });
	assert.deepEqual(await call('RetrieveTotalRecordCount', { EntityNames: 'account, contact' }), {
		path: 'RetrieveTotalRecordCount(EntityNames=@p1)',
		qs: { '@p1': '["account","contact"]' },
	});
	const init = await call('InitializeFrom', {
		EntityMoniker: '{"@odata.id":"custom"}',
		TargetEntityName: "o'brien",
		TargetFieldType: 'All',
		RetrieveConsumableRecord: '',
	});
	assert.equal(init.path, 'InitializeFrom(EntityMoniker=@p1,TargetEntityName=@p2,TargetFieldType=@p3)');
	assert.equal(init.qs['@p1'], '{"@odata.id":"custom"}');
	assert.equal(init.qs['@p2'], "'o''brien'");
	assert.equal(init.qs['@p3'], "Microsoft.Dynamics.CRM.TargetFieldType'All'");
	await assert.rejects(call('RetrieveTotalRecordCount', {}), /required/);
});

test('entity references are parsed from many notations', () => {
	const id = '35d9d0f0-97c4-f111-8d90-005056b20506';
	assert.deepEqual(odata.parseEntityReference(id), { id });
	assert.deepEqual(odata.parseEntityReference(`{${id.toUpperCase()}}`), { id });
	assert.deepEqual(odata.parseEntityReference(`accounts(${id})`), { entity: 'accounts', id });
	assert.deepEqual(odata.parseEntityReference(`/contacts(${id})`), { entity: 'contacts', id });
	assert.deepEqual(odata.parseEntityReference(`http://crm/org/api/data/v9.1/leads(${id})`), { entity: 'leads', id });
	assert.deepEqual(odata.parseEntityReference(`account:${id}`), { entity: 'account', id });
	assert.deepEqual(odata.parseEntityReference({ id, entity: 'team' }), { entity: 'team', id });
	assert.deepEqual(odata.parseEntityReference({ '@odata.id': `teams(${id})` }), { entity: 'teams', id });
	assert.equal(odata.parseEntityReference('not a reference'), undefined);
	assert.equal(odata.parseEntityReference(''), undefined);
});

test('null @odata.bind entries are moved out of request bodies', () => {
	assert.deepEqual(odata.extractNullBinds({ name: 'x', 'parentid@odata.bind': null, 'ownerid@odata.bind': '/teams(1)' }), {
		body: { name: 'x', 'ownerid@odata.bind': '/teams(1)' },
		navigationProperties: ['parentid'],
	});
});

test('batch body puts writes in a change set and reads after it', () => {
	const { body, order, contentIds } = odata.buildBatchBody(
		[
			{ method: 'GET', url: 'accounts?$top=1' },
			{ method: 'POST', url: 'accounts', body: { name: 'A' } },
			{ method: 'PATCH', url: '/accounts(1)', body: { name: 'B' }, contentId: 'x' },
		],
		'http://crm/org/api/data/v9.1',
		true,
		'b1',
	);
	assert.deepEqual(order, [1, 2, 0]);
	assert.deepEqual(contentIds, [undefined, '1', 'x']);
	assert.match(body, /--batch_b1\r\nContent-Type: multipart\/mixed; boundary=changeset_b1/);
	assert.match(body, /Content-ID: 1\r\n\r\nPOST \/org\/api\/data\/v9.1\/accounts HTTP\/1.1/);
	assert.match(body, /Content-ID: x\r\n\r\nPATCH \/org\/api\/data\/v9.1\/accounts\(1\) HTTP\/1.1/);
	assert.match(body, /GET \/org\/api\/data\/v9.1\/accounts\?\$top=1 HTTP\/1.1/);
	assert.ok(body.endsWith('--batch_b1--\r\n'));
});

test('batch responses are parsed including nested change sets', () => {
	const response = [
		'--batchresponse_1',
		'Content-Type: multipart/mixed; boundary=changesetresponse_2',
		'',
		'--changesetresponse_2',
		'Content-Type: application/http',
		'Content-Transfer-Encoding: binary',
		'Content-ID: 1',
		'',
		'HTTP/1.1 204 No Content',
		'OData-EntityId: http://crm/org/api/data/v9.1/accounts(11111111-1111-1111-1111-111111111111)',
		'',
		'',
		'--changesetresponse_2--',
		'--batchresponse_1',
		'Content-Type: application/http',
		'Content-Transfer-Encoding: binary',
		'',
		'HTTP/1.1 200 OK',
		'Content-Type: application/json; odata.metadata=minimal',
		'',
		'{"value":[{"name":"A"}]}',
		'--batchresponse_1--',
		'',
	].join('\r\n');
	const parsed = odata.parseBatchResponse(response, 'multipart/mixed; boundary=batchresponse_1');
	assert.equal(parsed.length, 2);
	assert.equal(parsed[0].contentId, '1');
	assert.equal(parsed[0].status, 204);
	assert.match(parsed[0].headers['odata-entityid'], /accounts\(1{8}-/);
	assert.equal(parsed[1].status, 200);
	assert.deepEqual(parsed[1].body, { value: [{ name: 'A' }] });
});

test('FetchXML paging helpers', () => {
	const fetch = '<fetch version="1.0" count="10" page="3"><entity name="account"><attribute name="name"/></entity></fetch>';
	const paged = odata.setFetchPaging(fetch, 2, 50, '<cookie page="1"><accountid last="{X}" /></cookie>');
	assert.equal(
		paged.match(/<fetch[^>]*>/)[0],
		'<fetch version="1.0" page="2" count="50" paging-cookie="&lt;cookie page=&quot;1&quot;&gt;&lt;accountid last=&quot;{X}&quot; /&gt;&lt;/cookie&gt;">',
	);
	const annotation = '<cookie pagenumber="2" pagingcookie="%253ccookie%2520page%253d%25221%2522%253e%253c%252fcookie%253e" istracking="False" />';
	assert.equal(odata.extractPagingCookie(annotation), '<cookie page="1"></cookie>');
	assert.equal(odata.fetchEntityName(fetch), 'account');
	assert.equal(odata.fetchHasTop('<fetch top="5"><entity name="a"/></fetch>'), true);
	assert.equal(odata.fetchIsAggregate("<fetch aggregate='true'><entity name='a'/></fetch>"), true);
});

test('common headers combine annotations into a single Prefer value', () => {
	const headers = odata.buildCommonHeaders({ annotations: 'formatted', impersonateUserId: '{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}' }, [
		'Microsoft.Dynamics.CRM.morerecords',
	]);
	assert.equal(headers.Prefer, 'odata.include-annotations="OData.Community.Display.V1.FormattedValue,Microsoft.Dynamics.CRM.morerecords"');
	assert.equal(headers.MSCRMCallerID, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
	assert.equal(odata.buildCommonHeaders({ annotations: 'all' }, ['x']).Prefer, 'odata.include-annotations="*"');
});

test('filter builder formats values by column type', () => {
	const { buildFilterFromAttributes } = require('../dist/nodes/Dynamics365/helpers/filter');
	const attribute = (logicalName, attributeType) => ({ logicalName, attributeType });
	const attributes = [
		attribute('name', 'String'),
		attribute('statuscode', 'Status'),
		attribute('revenue', 'Money'),
		attribute('donotemail', 'Boolean'),
		attribute('createdon', 'DateTime'),
		attribute('parentcustomerid', 'Customer'),
	];
	const build = (conditions, combinator = 'and') => buildFilterFromAttributes(attributes, conditions, combinator);
	const guid = 'BE8C1258-51EB-EA11-9679-000C29076E9C';

	assert.equal(build([{ column: 'name', operator: 'equals', value: "O'Brien" }]), "name eq 'O''Brien'");
	assert.equal(build([{ column: 'statuscode', operator: 'notEquals', value: '2' }]), 'statuscode ne 2');
	assert.equal(build([{ column: 'revenue', operator: 'greaterThan', value: '1000.5' }]), 'revenue gt 1000.5');
	assert.equal(build([{ column: 'donotemail', operator: 'equals', value: 'yes' }]), 'donotemail eq true');
	assert.equal(build([{ column: 'createdon', operator: 'lessThan', value: '2026-01-01' }]), 'createdon lt 2026-01-01');
	assert.equal(
		build([{ column: 'parentcustomerid', operator: 'equals', value: `{${guid}}` }]),
		`_parentcustomerid_value eq ${guid.toLowerCase()}`,
	);
	assert.equal(build([{ column: 'parentcustomerid', operator: 'isNull' }]), '_parentcustomerid_value eq null');
	assert.equal(build([{ column: 'name', operator: 'notContains', value: 'x' }]), "not contains(name,'x')");
	assert.equal(
		build([{ column: 'statuscode', operator: 'in', value: '1, 2' }]),
		'Microsoft.Dynamics.CRM.In(PropertyName=\'statuscode\',PropertyValues=["1","2"])',
	);
	assert.equal(
		build([{ column: 'createdon', operator: 'lastXDays', value: '7' }]),
		"Microsoft.Dynamics.CRM.LastXDays(PropertyName='createdon',PropertyValue=7)",
	);
	assert.equal(build([{ column: 'ownerid', operator: 'equalUserId' }]), "Microsoft.Dynamics.CRM.EqualUserId(PropertyName='ownerid')");
	assert.equal(
		build([{ column: 'name', operator: 'startsWith', value: 'A' }, { column: 'statuscode', operator: 'equals', value: '1' }], 'or'),
		"(startswith(name,'A')) or (statuscode eq 1)",
	);
	// Unknown columns (navigation paths) infer the literal type.
	assert.equal(build([{ column: 'primarycontactid/fullname', operator: 'equals', value: 'Ali' }]), "primarycontactid/fullname eq 'Ali'");
	assert.equal(build([{ column: 'custom/number', operator: 'equals', value: '42' }]), 'custom/number eq 42');
	assert.equal(build([{ column: '', operator: 'equals', value: 'x' }]), undefined);

	assert.throws(() => build([{ column: 'statuscode', operator: 'equals', value: 'active' }]), /expects a number/);
	assert.throws(() => build([{ column: 'createdon', operator: 'between', value: '2026-01-01' }]), /exactly two/);
	assert.throws(() => build([{ column: 'createdon', operator: 'lastXDays', value: 'week' }]), /whole number/);
});
