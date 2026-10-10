'use strict';

/**
 * Live tests against a Dynamics 365 server. Configure with environment variables:
 *
 *   DYNAMICS_URL=http://server/org DYNAMICS_USERNAME=user DYNAMICS_PASSWORD=secret npm run test:integration
 *
 * Optional: DYNAMICS_DOMAIN, DYNAMICS_API_VERSION (default 9.1).
 * Write tests (create/update/delete a record) only run with DYNAMICS_TEST_WRITE=1; they use
 * DYNAMICS_TEST_ENTITY (default contact) and DYNAMICS_TEST_RECORD (JSON with required columns,
 * default {"lastname":"n8n-node-test"}). Created records are deleted at the end.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContext } = require('./helpers/mockContext');
const { Dynamics365 } = require('../dist/nodes/Dynamics365/Dynamics365.node');
const { Dynamics365Trigger } = require('../dist/nodes/Dynamics365Trigger/Dynamics365Trigger.node');

const env = process.env;
const configured = env.DYNAMICS_URL && env.DYNAMICS_USERNAME && env.DYNAMICS_PASSWORD;
const credentials = {
	url: env.DYNAMICS_URL,
	apiVersion: env.DYNAMICS_API_VERSION || '9.1',
	username: env.DYNAMICS_USERNAME,
	password: env.DYNAMICS_PASSWORD,
	domain: env.DYNAMICS_DOMAIN || '',
};
const node = new Dynamics365();

async function run(params, items) {
	const [output] = await node.execute.call(createContext({ params, items, credentials }));
	return output.map((item) => item.json);
}

async function loadOptions(method, params = {}) {
	const fn = node.methods.loadOptions[method] ?? node.methods.resourceMapping[method];
	return await fn.call(createContext({ params, credentials }));
}

const live = { skip: configured ? false : 'DYNAMICS_URL / DYNAMICS_USERNAME / DYNAMICS_PASSWORD not set' };
const write = {
	skip: !configured ? live.skip : env.DYNAMICS_TEST_WRITE === '1' ? false : 'set DYNAMICS_TEST_WRITE=1 to run write tests',
};

test('credential test succeeds', live, async () => {
	const result = await node.methods.credentialTest.dynamics365NtlmApiTest.call({}, { data: credentials });
	assert.equal(result.status, 'OK', result.message);
});

test('credential test reports a wrong password', live, async () => {
	const result = await node.methods.credentialTest.dynamics365NtlmApiTest.call({}, {
		data: { ...credentials, password: `${credentials.password}-wrong` },
	});
	assert.equal(result.status, 'Error');
});

test('load options: entities, attributes, relationships, actions', live, async () => {
	const entities = await loadOptions('getEntityOptions');
	assert.ok(entities.some((e) => e.value === 'account'));
	const attributes = await loadOptions('getAttributeOptions', { entity: 'account' });
	assert.ok(attributes.some((a) => a.value === 'name'));
	const relationships = await loadOptions('getRelationshipOptions', { entity: 'account' });
	assert.ok(relationships.length > 0);
	const actions = await loadOptions('getActionOptions', { bindingScope: 'unbound' });
	assert.ok(actions.length > 10);
	const fields = await loadOptions('getRecordFields', { entity: 'account', operation: 'create' });
	assert.ok(fields.fields.some((f) => f.id === 'name'));
});

test('get many with paging and limit', live, async () => {
	const rows = await run({
		resource: 'record',
		operation: 'getMany',
		entity: 'systemuser',
		returnAll: false,
		limit: 3,
		options: { select: ['fullname'], pageSize: 2 },
	});
	assert.ok(rows.length <= 3 && rows.length > 0);
	assert.ok('systemuserid' in rows[0]);
});

test('FetchXML query with paging cookie', live, async () => {
	const rows = await run({
		resource: 'record',
		operation: 'fetchXml',
		fetchXml: '<fetch><entity name="systemuser"><attribute name="fullname"/><order attribute="fullname"/></entity></fetch>',
		returnAll: false,
		limit: 5,
		options: { pageSize: 2 },
	});
	assert.equal(new Set(rows.map((r) => r.systemuserid)).size, rows.length, 'pages must not overlap');
});

test('unbound functions with and without parameters', live, async () => {
	const [who] = await run({
		resource: 'action',
		operation: 'executeFunction',
		bindingScope: 'unbound',
		operationName: 'WhoAmI',
		parametersMode: 'json',
		parametersJson: '{}',
		options: {},
	});
	assert.ok(who.UserId);
	const [count] = await run({
		resource: 'action',
		operation: 'executeFunction',
		bindingScope: 'unbound',
		operationName: 'RetrieveTotalRecordCount',
		parametersMode: 'mapper',
		parameters: { mappingMode: 'defineBelow', value: { EntityNames: 'systemuser' } },
		options: {},
	});
	assert.deepEqual(count.EntityRecordCountCollection.Keys, ['systemuser']);
});

test('metadata operations', live, async () => {
	const [optionSet] = await run({
		resource: 'metadata',
		operation: 'getOptionSet',
		optionSetSource: 'attribute',
		entity: 'account',
		attribute: 'statecode',
	});
	assert.ok(optionSet.options.length >= 2);
	const operations = await run({ resource: 'metadata', operation: 'listOperations', operationKind: 'function', filters: { nameContains: 'WhoAmI' } });
	assert.equal(operations[0].name, 'WhoAmI');
});

test('batch with a GET request', live, async () => {
	const rows = await run(
		{
			resource: 'batch',
			operation: 'execute',
			requestsMode: 'json',
			combineItems: true,
			requestsJson: '[{"method":"GET","url":"systemusers?$top=1&$select=fullname"}]',
			options: {},
		},
		[{ json: {} }],
	);
	assert.equal(rows[0].status, 200);
	assert.equal(rows[0].body.value.length, 1);
});

test('custom request', live, async () => {
	const [version] = await run({ resource: 'customRequest', operation: 'request', method: 'GET', path: 'RetrieveVersion()', responseFormat: 'auto', options: {} });
	assert.match(version.Version, /^\d+\.\d+/);
});

test('trigger returns the latest record in manual mode', live, async () => {
	const trigger = new Dynamics365Trigger();
	const ctx = createContext({ params: { entity: 'systemuser', event: 'createdOrUpdated', options: {} }, credentials, mode: 'manual' });
	const result = await trigger.poll.call(ctx);
	assert.equal(result[0].length, 1);
});

test('record lifecycle: create, get, update, get field value, delete', write, async () => {
	const entity = env.DYNAMICS_TEST_ENTITY || 'contact';
	const values = JSON.parse(env.DYNAMICS_TEST_RECORD || '{"lastname":"n8n-node-test"}');
	const [created] = await run({
		resource: 'record',
		operation: 'create',
		entity,
		dataMode: 'json',
		jsonBody: JSON.stringify(values),
		options: { returnRecord: false },
	});
	assert.ok(created.id);
	const target = { resource: 'record', entity, identifyBy: 'id', recordId: created.id };
	try {
		const [fetched] = await run({ ...target, operation: 'get', options: {} });
		assert.ok(fetched);
		await run({ ...target, operation: 'update', dataMode: 'json', jsonBody: '{}', options: { returnRecord: false } });
		const firstKey = Object.keys(values)[0];
		const [field] = await run({ ...target, operation: 'getFieldValue', field: firstKey, options: {} });
		assert.equal(field[firstKey], values[firstKey]);
	} finally {
		const [deleted] = await run({ ...target, operation: 'delete', options: {} });
		assert.equal(deleted.deleted, true);
	}
});
