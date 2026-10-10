import type { INodeProperties } from 'n8n-workflow';
import { impersonationOption, timeoutOption } from './shared';

const show = (extra: Record<string, unknown[]> = {}) => ({
	show: { resource: ['batch'], operation: ['execute'], ...extra },
});

export const batchOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['batch'] } },
		options: [
			{
				name: 'Execute',
				value: 'execute',
				description: 'Send many requests in a single $batch call',
				action: 'Execute a batch request',
			},
		],
		default: 'execute',
	},
];

export const batchFields: INodeProperties[] = [
	{
		displayName: 'Requests Input Mode',
		name: 'requestsMode',
		type: 'options',
		options: [
			{ name: 'Define Below', value: 'define', description: 'Build requests with the fields below (evaluated per input item)' },
			{ name: 'JSON', value: 'json', description: 'Provide an array of requests as JSON' },
		],
		default: 'define',
		displayOptions: show(),
	},
	{
		displayName: 'Requests',
		name: 'requests',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true, sortable: true },
		placeholder: 'Add Request',
		default: {},
		displayOptions: show({ requestsMode: ['define'] }),
		options: [
			{
				displayName: 'Request',
				name: 'request',
				values: [
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
						default: 'POST',
					},
					{
						displayName: 'URL',
						name: 'url',
						type: 'string',
						default: '',
						placeholder: 'accounts',
						description: 'Path relative to the Web API root, e.g. accounts or accounts(GUID). Use $1 to reference the result of an earlier request in the change set.',
					},
					{
						displayName: 'Body (JSON)',
						name: 'body',
						type: 'json',
						default: '',
					},
					{
						displayName: 'Content ID',
						name: 'contentId',
						type: 'string',
						default: '',
						description: 'Optional identifier used to reference this request ($ID) inside the change set',
					},
					{
						displayName: 'Headers (JSON)',
						name: 'headers',
						type: 'json',
						default: '',
						placeholder: '{"Prefer": "return=representation"}',
					},
				],
			},
		],
	},
	{
		displayName: 'Requests (JSON)',
		name: 'requestsJson',
		type: 'json',
		default: '[\n  { "method": "POST", "url": "accounts", "body": { "name": "Example" } },\n  { "method": "GET", "url": "accounts?$top=1&$select=name" }\n]',
		description: 'Array of objects with method, url, optional body, headers and contentId',
		displayOptions: show({ requestsMode: ['json'] }),
	},
	{
		displayName: 'Combine All Items Into One Batch',
		name: 'combineItems',
		type: 'boolean',
		default: true,
		description: 'Whether to send the requests from all input items in one batch (one output item per request) or one batch per input item',
		displayOptions: show(),
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
				displayName: 'Atomic (Change Set)',
				name: 'useChangeset',
				type: 'boolean',
				default: true,
				description: 'Whether to put write requests in a change set so they all succeed or all fail together',
			},
			{
				displayName: 'Continue on Error',
				name: 'continueOnError',
				type: 'boolean',
				default: false,
				description: 'Whether to continue processing the remaining requests after one fails (only outside a change set)',
			},
			{
				displayName: 'Max Requests Per Batch',
				name: 'batchSize',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 1000 },
				default: 1000,
				description: 'Large request lists are split into multiple batches of this size',
			},
			{
				displayName: 'Fail on Request Error',
				name: 'failOnError',
				type: 'boolean',
				default: false,
				description: 'Whether to throw when any request inside the batch fails instead of returning its error in the output',
			},
			impersonationOption,
			timeoutOption,
		],
	},
];
