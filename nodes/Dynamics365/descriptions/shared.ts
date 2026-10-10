import type { INodeProperties } from 'n8n-workflow';

export const entityProperty = (
	resource: string,
	operations: string[],
	overrides: Partial<INodeProperties> = {},
): INodeProperties => ({
	displayName: 'Table (Entity) Name or ID',
	name: 'entity',
	type: 'options',
	typeOptions: { loadOptionsMethod: 'getEntityOptions' },
	required: true,
	default: '',
	description:
		'The table to work with. Choose from the list, or specify a logical name (e.g. account) or entity set name (e.g. accounts) using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
	displayOptions: { show: { resource: [resource], operation: operations } },
	...overrides,
});

export const recordIdentification = (resource: string, operations: string[]): INodeProperties[] => [
	{
		displayName: 'Identify Record By',
		name: 'identifyBy',
		type: 'options',
		options: [
			{ name: 'ID (GUID)', value: 'id' },
			{ name: 'Alternate Key', value: 'alternateKey' },
		],
		default: 'id',
		displayOptions: { show: { resource: [resource], operation: operations } },
	},
	{
		displayName: 'Record ID',
		name: 'recordId',
		type: 'string',
		required: true,
		default: '',
		placeholder: '00000000-0000-0000-0000-000000000000',
		description: 'GUID of the record',
		displayOptions: { show: { resource: [resource], operation: operations, identifyBy: ['id'] } },
	},
	{
		displayName: 'Alternate Key',
		name: 'alternateKey',
		type: 'fixedCollection',
		typeOptions: { multipleValues: true },
		placeholder: 'Add Key Column',
		default: {},
		description: 'Columns of an alternate key defined on the table',
		displayOptions: { show: { resource: [resource], operation: operations, identifyBy: ['alternateKey'] } },
		options: [
			{
				displayName: 'Key',
				name: 'keys',
				values: [
					{
						displayName: 'Column Name or ID',
						name: 'key',
						type: 'options',
						typeOptions: { loadOptionsMethod: 'getAllAttributeOptions', loadOptionsDependsOn: ['entity'] },
						default: '',
						description:
							'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
					},
					{
						displayName: 'Value',
						name: 'value',
						type: 'string',
						default: '',
					},
				],
			},
		],
	},
];

export const annotationsOption: INodeProperties = {
	displayName: 'Annotations',
	name: 'annotations',
	type: 'options',
	options: [
		{ name: 'None', value: 'none' },
		{ name: 'Formatted Values (Labels)', value: 'formatted', description: 'Include display labels for option sets, lookups, money and dates' },
		{ name: 'All', value: 'all', description: 'Include all OData annotations (formatted values, lookup logical names, ...)' },
	],
	default: 'none',
	description: 'Which OData annotations to include in the response',
};

export const impersonationOption: INodeProperties = {
	displayName: 'Impersonate User ID',
	name: 'impersonateUserId',
	type: 'string',
	default: '',
	placeholder: '00000000-0000-0000-0000-000000000000',
	description: 'GUID of a system user to impersonate (sent as MSCRMCallerID). The account needs the "Act on Behalf of Another User" privilege.',
};

export const writeOptions: INodeProperties[] = [
	impersonationOption,
	{
		displayName: 'Enable Duplicate Detection',
		name: 'duplicateDetection',
		type: 'boolean',
		default: false,
		description: 'Whether to run duplicate detection rules (MSCRM.SuppressDuplicateDetection: false)',
	},
	{
		displayName: 'Bypass Custom Plugins',
		name: 'bypassCustomPluginExecution',
		type: 'boolean',
		default: false,
		description: 'Whether to skip custom synchronous plugins (MSCRM.BypassCustomPluginExecution). Requires the prvBypassCustomPlugins privilege.',
	},
];

export const timeoutOption: INodeProperties = {
	displayName: 'Timeout (Ms)',
	name: 'timeout',
	type: 'number',
	typeOptions: { minValue: 1000 },
	default: 120000,
	description: 'Time in milliseconds to wait for the server to respond',
};
