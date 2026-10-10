import type { INodeProperties } from 'n8n-workflow';
import { entityProperty } from './shared';

const show = (operation: string[], extra: Record<string, unknown[]> = {}) => ({
	show: { resource: ['metadata'], operation, ...extra },
});

export const metadataOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['metadata'] } },
		options: [
			{ name: 'Clear Cache', value: 'clearCache', description: 'Forget cached metadata (use after customizations)', action: 'Clear the metadata cache' },
			{ name: 'Get Action or Function', value: 'getOperation', description: 'Get the definition of an action or function', action: 'Get an action or function definition' },
			{ name: 'Get Option Set', value: 'getOptionSet', description: 'Get the options (values and labels) of a choice column or global option set', action: 'Get an option set' },
			{ name: 'Get Table', value: 'getEntity', description: 'Get the definition of a table', action: 'Get a table definition' },
			{ name: 'List Actions and Functions', value: 'listOperations', description: 'List actions and functions exposed by the service', action: 'List actions and functions' },
			{ name: 'List Columns', value: 'listAttributes', description: 'List the columns of a table', action: 'List columns of a table' },
			{ name: 'List Global Option Sets', value: 'listGlobalOptionSets', action: 'List global option sets' },
			{ name: 'List Relationships', value: 'listRelationships', description: 'List the relationships of a table', action: 'List relationships of a table' },
			{ name: 'List Tables', value: 'listEntities', description: 'List all tables (entities)', action: 'List tables' },
		],
		default: 'listEntities',
	},
];

export const metadataFields: INodeProperties[] = [
	entityProperty('metadata', ['getEntity', 'listAttributes', 'listRelationships']),
	{
		displayName: 'Custom Tables Only',
		name: 'customOnly',
		type: 'boolean',
		default: false,
		displayOptions: show(['listEntities']),
	},
	{
		displayName: 'Raw Metadata',
		name: 'raw',
		type: 'boolean',
		default: false,
		description: 'Whether to return the complete metadata as returned by the server instead of a simplified version',
		displayOptions: show(['getEntity', 'listAttributes']),
	},
	{
		displayName: 'Option Set Source',
		name: 'optionSetSource',
		type: 'options',
		options: [
			{ name: 'Table Column', value: 'attribute' },
			{ name: 'Global Option Set', value: 'global' },
		],
		default: 'attribute',
		displayOptions: show(['getOptionSet']),
	},
	entityProperty('metadata', ['getOptionSet'], {
		displayOptions: show(['getOptionSet'], { optionSetSource: ['attribute'] }),
	}),
	{
		displayName: 'Column Name or ID',
		name: 'attribute',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getAllAttributeOptions', loadOptionsDependsOn: ['entity'] },
		required: true,
		default: '',
		description: 'Choice, state, status or yes/no column. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: show(['getOptionSet'], { optionSetSource: ['attribute'] }),
	},
	{
		displayName: 'Global Option Set Name or ID',
		name: 'globalOptionSet',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getGlobalOptionSetOptions' },
		required: true,
		default: '',
		description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
		displayOptions: show(['getOptionSet'], { optionSetSource: ['global'] }),
	},
	{
		displayName: 'Kind',
		name: 'operationKind',
		type: 'options',
		options: [
			{ name: 'Actions and Functions', value: 'all' },
			{ name: 'Actions', value: 'action' },
			{ name: 'Functions', value: 'function' },
		],
		default: 'all',
		displayOptions: show(['listOperations']),
	},
	{
		displayName: 'Kind',
		name: 'operationKind',
		type: 'options',
		options: [
			{ name: 'Action', value: 'action' },
			{ name: 'Function', value: 'function' },
		],
		default: 'action',
		displayOptions: show(['getOperation']),
	},
	{
		displayName: 'Name',
		name: 'operationName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'QualifyLead',
		displayOptions: show(['getOperation']),
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show(['listOperations']),
		options: [
			{
				displayName: 'Binding',
				name: 'binding',
				type: 'options',
				options: [
					{ name: 'Any', value: 'any' },
					{ name: 'Unbound', value: 'unbound' },
					{ name: 'Bound to Record', value: 'entity' },
					{ name: 'Bound to Collection', value: 'collection' },
				],
				default: 'any',
			},
			{
				displayName: 'Bound Table',
				name: 'boundEntity',
				type: 'string',
				default: '',
				placeholder: 'lead',
				description: 'Only operations bound to this table (logical name)',
			},
			{
				displayName: 'Name Contains',
				name: 'nameContains',
				type: 'string',
				default: '',
			},
		],
	},
];
