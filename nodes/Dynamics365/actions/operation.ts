import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { dynamicsApiRequest } from '../transport';
import { findOperation, type OperationScope } from '../helpers/csdl';
import { getCsdl, resolveEntity } from '../helpers/metadata';
import {
	buildActionBody,
	buildCommonHeaders,
	buildFunctionCall,
	buildKeySegment,
	normalizeGuid,
	operationPath,
} from '../helpers/odata';
import { getJsonObject, getMappedValues, getOptions, requestTimeout, wrapBody, type OperationResult } from './common';

async function resolveOperation(this: IExecuteFunctions, kind: 'action' | 'function', i: number) {
	const scope = this.getNodeParameter('bindingScope', i, 'unbound') as OperationScope;
	const name = String(this.getNodeParameter('operationName', i) ?? '').trim();
	const model = await getCsdl.call(this);

	let boundPath: string | undefined;
	let entityName: string | undefined;
	if (scope !== 'unbound') {
		const entity = await resolveEntity.call(this, this.getNodeParameter('entity', i) as string, i);
		entityName = entity.logicalName;
		boundPath = entity.entitySetName;
		if (scope === 'entity') {
			const recordId = this.getNodeParameter('recordId', i) as string;
			boundPath += await buildKeySegment.call(this, entity, recordId, undefined, i);
		}
	}

	const operation = findOperation(model, kind, name, scope, entityName);
	if (!operation) {
		const where = scope === 'unbound' ? 'as an unbound operation' : `for table "${entityName}" (${scope})`;
		throw new NodeOperationError(this.getNode(), `The ${kind} "${name}" was not found ${where}`, {
			itemIndex: i,
			description: 'Use Metadata → List Actions and Functions to see what the server exposes, or clear the metadata cache after customizations.',
		});
	}
	return { model, operation, boundPath };
}

/** Collection results ({ value: [...] }) become one item per entry. */
function toResult(response: unknown): OperationResult {
	if (response && typeof response === 'object' && Array.isArray((response as IDataObject).value)) {
		const keys = Object.keys(response as IDataObject).filter((key) => !key.startsWith('@'));
		if (keys.length === 1) return (response as IDataObject).value as IDataObject[];
	}
	return wrapBody(response);
}

function getParameterValues(this: IExecuteFunctions, i: number): IDataObject {
	const mode = this.getNodeParameter('parametersMode', i, 'mapper') as string;
	return mode === 'json' ? getJsonObject.call(this, 'parametersJson', i) : getMappedValues.call(this, 'parameters', i);
}

async function executeAction(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const { model, operation, boundPath } = await resolveOperation.call(this, 'action', i);
	const values = getParameterValues.call(this, i);
	const body = await buildActionBody.call(this, model, operation, values, i);
	const options = getOptions.call(this, i);
	const response = await dynamicsApiRequest.call(this, 'POST', operationPath(operation, boundPath), body, {
		headers: buildCommonHeaders(options),
		timeout: requestTimeout(options),
		itemIndex: i,
	});
	return toResult(response);
}

async function executeFunction(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const { model, operation, boundPath } = await resolveOperation.call(this, 'function', i);
	const values = getParameterValues.call(this, i);
	const { path, qs } = await buildFunctionCall.call(this, model, operation, values, boundPath, i);
	const options = getOptions.call(this, i);
	const response = await dynamicsApiRequest.call(this, 'GET', path, undefined, {
		headers: buildCommonHeaders(options),
		qs,
		timeout: requestTimeout(options),
		itemIndex: i,
	});
	return toResult(response);
}

async function runWorkflow(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const workflowId = normalizeGuid(this.getNodeParameter('workflowId', i) as string);
	const recordId = normalizeGuid(this.getNodeParameter('recordId', i) as string);
	const options = getOptions.call(this, i);
	const response = await dynamicsApiRequest.call(
		this,
		'POST',
		`workflows(${workflowId})/Microsoft.Dynamics.CRM.ExecuteWorkflow`,
		{ EntityId: recordId },
		{ headers: buildCommonHeaders(options), timeout: requestTimeout(options), itemIndex: i },
	);
	return { workflowId, recordId, ...wrapBody(response) };
}

export const actionOperations: Record<string, (this: IExecuteFunctions, i: number) => Promise<OperationResult>> = {
	executeAction,
	executeFunction,
	runWorkflow,
};
