import type {
	NodeConnectionType,
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { recordFields, recordOperations as recordOperationProperties } from './descriptions/RecordDescription';
import { operationFields, operationOperations } from './descriptions/OperationDescription';
import { metadataFields, metadataOperations as metadataOperationProperties } from './descriptions/MetadataDescription';
import { batchFields, batchOperations } from './descriptions/BatchDescription';
import { customRequestFields, customRequestOperations } from './descriptions/CustomRequestDescription';
import { recordOperations } from './actions/record';
import { actionOperations } from './actions/operation';
import { metadataOperations } from './actions/metadata';
import { executeBatch } from './actions/batch';
import { customRequest } from './actions/customRequest';
import type { OperationResult } from './actions/common';
import * as loadOptions from './methods/loadOptions';
import * as resourceMapping from './methods/resourceMapping';
import { dynamics365NtlmApiTest } from './methods/credentialTest';

const handlers: Record<string, Record<string, (this: IExecuteFunctions, i: number) => Promise<OperationResult>>> = {
	record: recordOperations,
	action: actionOperations,
	metadata: metadataOperations,
	customRequest: { request: customRequest },
};

export class Dynamics365 implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dynamics 365 (On-Premises)',
		name: 'dynamics365OnPrem',
		icon: 'file:dynamics365.png',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Work with Microsoft Dynamics 365 / Dataverse on-premises through the Web API using NTLM authentication',
		defaults: { name: 'Dynamics 365' },
		usableAsTool: true,
		// A string literal instead of NodeConnectionTypes keeps the node loadable on n8n < 1.83.
		inputs: ['main' as NodeConnectionType],
		outputs: ['main' as NodeConnectionType],
		credentials: [{ name: 'dynamics365NtlmApi', required: true, testedBy: 'dynamics365NtlmApiTest' }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Action / Function', value: 'action' },
					{ name: 'Batch', value: 'batch' },
					{ name: 'Custom API Call', value: 'customRequest' },
					{ name: 'Metadata', value: 'metadata' },
					{ name: 'Record', value: 'record' },
				],
				default: 'record',
			},
			...recordOperationProperties,
			...recordFields,
			...operationOperations,
			...operationFields,
			...metadataOperationProperties,
			...metadataFields,
			...batchOperations,
			...batchFields,
			...customRequestOperations,
			...customRequestFields,
		],
	};

	methods = {
		loadOptions: {
			getEntityOptions: loadOptions.getEntityOptions,
			getAttributeOptions: loadOptions.getAttributeOptions,
			getAllAttributeOptions: loadOptions.getAllAttributeOptions,
			getFilterAttributeOptions: loadOptions.getFilterAttributeOptions,
			getBinaryAttributeOptions: loadOptions.getBinaryAttributeOptions,
			getRelationshipOptions: loadOptions.getRelationshipOptions,
			getStateCodeOptions: loadOptions.getStateCodeOptions,
			getStatusCodeOptions: loadOptions.getStatusCodeOptions,
			getActionOptions: loadOptions.getActionOptions,
			getFunctionOptions: loadOptions.getFunctionOptions,
			getViewOptions: loadOptions.getViewOptions,
			getWorkflowOptions: loadOptions.getWorkflowOptions,
			getGlobalOptionSetOptions: loadOptions.getGlobalOptionSetOptions,
			getUserOptions: loadOptions.getUserOptions,
			getTeamOptions: loadOptions.getTeamOptions,
		},
		resourceMapping: {
			getRecordFields: resourceMapping.getRecordFields,
			getOperationParameters: resourceMapping.getOperationParameters,
		},
		credentialTest: {
			dynamics365NtlmApiTest,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0) as string;

		if (resource === 'batch') {
			return [await executeBatch.call(this)];
		}

		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				const handler = handlers[resource]?.[operation];
				if (!handler) {
					throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported for "${resource}"`, {
						itemIndex: i,
					});
				}
				const result = await handler.call(this, i);
				if (result === undefined) continue;

				if (Array.isArray(result) && result.length && 'json' in (result[0] as object)) {
					returnData.push(...(result as INodeExecutionData[]));
					continue;
				}
				const executionData = this.helpers.constructExecutionMetaData(
					this.helpers.returnJsonArray(result as IDataObject | IDataObject[]),
					{ itemData: { item: i } },
				);
				returnData.push(...executionData);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message, ...((error as { description?: string }).description ? { description: (error as { description?: string }).description } : {}) },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error;
			}
		}

		return [returnData];
	}
}
