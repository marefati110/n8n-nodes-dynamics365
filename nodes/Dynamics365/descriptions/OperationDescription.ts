import type { INodeProperties } from 'n8n-workflow';
import { entityProperty, impersonationOption, timeoutOption, writeOptions } from './shared';

const show = (operation: string[], extra: Record<string, unknown[]> = {}) => ({
	show: { resource: ['action'], operation, ...extra },
});

const OPERATIONS = ['executeAction', 'executeFunction'];

export const operationOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['action'] } },
		options: [
			{
				name: 'Execute Action',
				value: 'executeAction',
				description: 'Run any Web API action (system or custom), unbound or bound to a table',
				action: 'Execute an action',
			},
			{
				name: 'Execute Function',
				value: 'executeFunction',
				description: 'Run any Web API function, unbound or bound to a table',
				action: 'Execute a function',
			},
			{
				name: 'Run Workflow',
				value: 'runWorkflow',
				description: 'Run an on-demand workflow (process) against a record',
				action: 'Run a workflow',
			},
		],
		default: 'executeAction',
	},
];

export const operationFields: INodeProperties[] = [
	{
		displayName: 'Binding',
		name: 'bindingScope',
		type: 'options',
		options: [
			{ name: 'Unbound (Global)', value: 'unbound' },
			{ name: 'Bound to a Record', value: 'entity' },
			{ name: 'Bound to a Table (Collection)', value: 'collection' },
		],
		default: 'unbound',
		description: 'Whether the operation is global or is invoked on a record or table',
		displayOptions: show(OPERATIONS),
	},
	entityProperty('action', OPERATIONS, {
		displayOptions: show(OPERATIONS, { bindingScope: ['entity', 'collection'] }),
	}),
	{
		displayName: 'Record ID',
		name: 'recordId',
		type: 'string',
		required: true,
		default: '',
		placeholder: '00000000-0000-0000-0000-000000000000',
		displayOptions: show(OPERATIONS, { bindingScope: ['entity'] }),
	},
	{
		displayName: 'Action Name or ID',
		name: 'operationName',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getActionOptions', loadOptionsDependsOn: ['bindingScope', 'entity'] },
		required: true,
		default: '',
		description:
			'Actions are read from the service metadata. Choose from the list, or specify a name using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: show(['executeAction']),
	},
	{
		displayName: 'Function Name or ID',
		name: 'operationName',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getFunctionOptions', loadOptionsDependsOn: ['bindingScope', 'entity'] },
		required: true,
		default: '',
		description:
			'Functions are read from the service metadata. Choose from the list, or specify a name using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: show(['executeFunction']),
	},
	{
		displayName: 'Parameters Input Mode',
		name: 'parametersMode',
		type: 'options',
		options: [
			{ name: 'Map Parameters', value: 'mapper' },
			{ name: 'JSON', value: 'json' },
		],
		default: 'mapper',
		displayOptions: show(OPERATIONS),
	},
	{
		displayName: 'Parameters',
		name: 'parameters',
		type: 'resourceMapper',
		noDataExpression: true,
		default: { mappingMode: 'defineBelow', value: null },
		required: true,
		typeOptions: {
			loadOptionsDependsOn: ['operationName', 'bindingScope', 'entity', 'operation'],
			resourceMapper: {
				resourceMapperMethod: 'getOperationParameters',
				mode: 'add',
				fieldWords: { singular: 'parameter', plural: 'parameters' },
				addAllFields: true,
				multiKeyMatch: false,
				supportAutoMap: false,
				noFieldsError: 'This operation has no parameters',
			},
		},
		description:
			'Record parameters accept "accounts(GUID)", "account:GUID" or a JSON object. Collections accept a JSON array or comma-separated values.',
		displayOptions: show(OPERATIONS, { parametersMode: ['mapper'] }),
	},
	{
		displayName: 'Parameters (JSON)',
		name: 'parametersJson',
		type: 'json',
		default: '{}',
		description:
			'Parameters as a JSON object. For actions this is the request body; for functions each property becomes a parameter alias.',
		displayOptions: show(OPERATIONS, { parametersMode: ['json'] }),
	},

	/* -------------------------------------------------------------- workflow */
	{
		displayName: 'Workflow Name or ID',
		name: 'workflowId',
		type: 'options',
		typeOptions: { loadOptionsMethod: 'getWorkflowOptions' },
		required: true,
		default: '',
		description:
			'Activated on-demand workflow. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
		displayOptions: show(['runWorkflow']),
	},
	{
		displayName: 'Record ID',
		name: 'recordId',
		type: 'string',
		required: true,
		default: '',
		placeholder: '00000000-0000-0000-0000-000000000000',
		description: 'GUID of the record the workflow runs against',
		displayOptions: show(['runWorkflow']),
	},

	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['executeAction', 'runWorkflow']),
		options: [...writeOptions, timeoutOption],
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['executeFunction']),
		options: [impersonationOption, timeoutOption],
	},
];
