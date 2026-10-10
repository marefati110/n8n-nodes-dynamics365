import type { INodeProperties } from 'n8n-workflow';
import { timeoutOption } from './shared';

const show = (extra: Record<string, unknown[]> = {}) => ({
	show: { resource: ['customRequest'], operation: ['request'], ...extra },
});

export const customRequestOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['customRequest'] } },
		options: [
			{
				name: 'Send Request',
				value: 'request',
				description: 'Send any request to the Web API using the NTLM credentials',
				action: 'Send a custom request',
			},
		],
		default: 'request',
	},
];

export const customRequestFields: INodeProperties[] = [
	{
		displayName: 'Method',
		name: 'method',
		type: 'options',
		options: [
			{ name: 'DELETE', value: 'DELETE' },
			{ name: 'GET', value: 'GET' },
			{ name: 'PATCH', value: 'PATCH' },
			{ name: 'POST', value: 'POST' },
			{ name: 'PUT', value: 'PUT' },
		],
		default: 'GET',
		displayOptions: show(),
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'accounts?$select=name&$top=10',
		description: 'Path relative to the Web API root (…/api/data/v9.x/). A full URL is also accepted.',
		displayOptions: show(),
	},
	{
		displayName: 'Query Parameters',
		name: 'queryParameters',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Parameter',
		default: {},
		displayOptions: show(),
		options: [
			{
				displayName: 'Parameter',
				name: 'parameter',
				values: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Value', name: 'value', type: 'string', default: '' },
				],
			},
		],
	},
	{
		displayName: 'Headers',
		name: 'headers',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Header',
		default: {},
		displayOptions: show(),
		options: [
			{
				displayName: 'Header',
				name: 'header',
				values: [
					{ displayName: 'Name', name: 'name', type: 'string', default: '' },
					{ displayName: 'Value', name: 'value', type: 'string', default: '' },
				],
			},
		],
	},
	{
		displayName: 'Send Body',
		name: 'sendBody',
		type: 'boolean',
		default: false,
		displayOptions: show({ method: ['PATCH', 'POST', 'PUT', 'DELETE'] }),
	},
	{
		displayName: 'Body Content Type',
		name: 'bodyContentType',
		type: 'options',
		options: [
			{ name: 'JSON', value: 'json' },
			{ name: 'Binary (n8n Binary File)', value: 'binary' },
			{ name: 'Raw Text', value: 'raw' },
		],
		default: 'json',
		displayOptions: show({ sendBody: [true] }),
	},
	{
		displayName: 'Body (JSON)',
		name: 'jsonBody',
		type: 'json',
		default: '{}',
		displayOptions: show({ sendBody: [true], bodyContentType: ['json'] }),
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		displayOptions: show({ sendBody: [true], bodyContentType: ['binary'] }),
	},
	{
		displayName: 'Body',
		name: 'rawBody',
		type: 'string',
		typeOptions: { rows: 5 },
		default: '',
		displayOptions: show({ sendBody: [true], bodyContentType: ['raw'] }),
	},
	{
		displayName: 'Content Type',
		name: 'rawContentType',
		type: 'string',
		default: 'text/plain',
		displayOptions: show({ sendBody: [true], bodyContentType: ['raw'] }),
	},
	{
		displayName: 'Response Format',
		name: 'responseFormat',
		type: 'options',
		options: [
			{ name: 'Auto (JSON or Text)', value: 'auto' },
			{ name: 'File (Binary)', value: 'binary' },
		],
		default: 'auto',
		displayOptions: show(),
	},
	{
		displayName: 'Put Output File in Field',
		name: 'outputBinaryPropertyName',
		type: 'string',
		default: 'data',
		displayOptions: show({ responseFormat: ['binary'] }),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(),
		options: [
			{
				displayName: 'Full Response',
				name: 'fullResponse',
				type: 'boolean',
				default: false,
				description: 'Whether to return status code and headers along with the body',
			},
			{
				displayName: 'Split Collection Into Items',
				name: 'splitValue',
				type: 'boolean',
				default: true,
				description: 'Whether to output one item per entry when the response contains a "value" array',
			},
			{
				displayName: 'Follow Next Links',
				name: 'followNextLink',
				type: 'boolean',
				default: false,
				description: 'Whether to follow @odata.nextLink and return all pages (GET only)',
			},
			timeoutOption,
		],
	},
];
