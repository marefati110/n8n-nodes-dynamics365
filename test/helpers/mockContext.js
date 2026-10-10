'use strict';

/**
 * Minimal stand-in for n8n's IExecuteFunctions / ILoadOptionsFunctions / IPollFunctions,
 * enough to run the node's code paths outside of n8n.
 */

function getPath(object, path) {
	return path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function createContext({ params = {}, items = [{ json: {} }], credentials, mode = 'trigger', staticData = {} }) {
	const paramsFor = (i) => (Array.isArray(params) ? params[i] ?? params[0] : params);
	const node = {
		id: 'test-node',
		name: 'Dynamics 365',
		type: 'n8n-nodes-dynamics365.dynamics365OnPrem',
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
	return {
		getNodeParameter(name, itemIndexOrFallback, fallback) {
			// IPollFunctions signature is (name, fallback); IExecuteFunctions is (name, index, fallback).
			const isPoll = typeof itemIndexOrFallback !== 'number';
			const value = getPath(paramsFor(isPoll ? 0 : itemIndexOrFallback), name);
			if (value === undefined) {
				const def = isPoll ? itemIndexOrFallback : fallback;
				if (def === undefined) throw new Error(`Parameter "${name}" is not set`);
				return def;
			}
			return value;
		},
		getCurrentNodeParameter(name) {
			return getPath(paramsFor(0), name);
		},
		async getCredentials() {
			return credentials;
		},
		getNode() {
			return node;
		},
		getInputData() {
			return items;
		},
		continueOnFail() {
			return false;
		},
		getMode() {
			return mode;
		},
		getWorkflowStaticData() {
			return staticData;
		},
		helpers: {
			returnJsonArray(data) {
				return (Array.isArray(data) ? data : [data]).map((json) => ({ json }));
			},
			constructExecutionMetaData(executionItems, { itemData }) {
				return executionItems.map((item) => ({ ...item, pairedItem: itemData }));
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return { data: buffer.toString('base64'), fileName, mimeType, fileSize: buffer.length };
			},
			assertBinaryData(i, property) {
				const binary = items[i]?.binary?.[property];
				if (!binary) throw new Error(`No binary property "${property}" on item ${i}`);
				return binary;
			},
			async getBinaryDataBuffer(i, property) {
				return Buffer.from(items[i].binary[property].data, 'base64');
			},
		},
	};
}

module.exports = { createContext };
