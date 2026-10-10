import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { clearCache, dynamicsApiRequest, getConnection } from '../transport';
import { describeType, operationScope, type CsdlOperation } from '../helpers/csdl';
import {
	getAttributes,
	getCsdl,
	getEntities,
	getRelationships,
	label,
	resolveEntity,
} from '../helpers/metadata';
import { wrapBody, type OperationResult } from './common';

function describeOperation(operation: CsdlOperation): IDataObject {
	return {
		name: operation.name,
		kind: operation.kind,
		binding: operationScope(operation),
		boundEntity: operation.boundEntity ?? null,
		parameters: operation.parameters.map((p) => ({
			name: p.name,
			type: describeType(p.type),
			required: !p.nullable && !p.optional,
		})),
		returnType: operation.returnType ? describeType(operation.returnType) : null,
	};
}

async function listEntities(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const customOnly = this.getNodeParameter('customOnly', i, false) as boolean;
	const entities = await getEntities.call(this);
	return entities.filter((e) => !customOnly || e.isCustomEntity) as unknown as IDataObject[];
}

async function getEntity(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await resolveEntity.call(this, this.getNodeParameter('entity', i) as string, i);
	if (this.getNodeParameter('raw', i, false)) {
		return wrapBody(await dynamicsApiRequest.call(this, 'GET', `EntityDefinitions(LogicalName='${entity.logicalName}')`));
	}
	const [attributes, relationships] = await Promise.all([
		getAttributes.call(this, entity.logicalName),
		getRelationships.call(this, entity.logicalName),
	]);
	return { ...entity, attributeCount: attributes.length, relationshipCount: relationships.length } as unknown as IDataObject;
}

async function listAttributes(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await resolveEntity.call(this, this.getNodeParameter('entity', i) as string, i);
	if (this.getNodeParameter('raw', i, false)) {
		const response = (await dynamicsApiRequest.call(
			this,
			'GET',
			`EntityDefinitions(LogicalName='${entity.logicalName}')/Attributes`,
		)) as IDataObject;
		return (response.value as IDataObject[]) ?? [];
	}
	return (await getAttributes.call(this, entity.logicalName)) as unknown as IDataObject[];
}

async function listRelationships(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await resolveEntity.call(this, this.getNodeParameter('entity', i) as string, i);
	return (await getRelationships.call(this, entity.logicalName)) as unknown as IDataObject[];
}

async function getOptionSet(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const source = this.getNodeParameter('optionSetSource', i, 'attribute') as string;
	if (source === 'global') {
		const name = this.getNodeParameter('globalOptionSet', i) as string;
		const response = (await dynamicsApiRequest.call(this, 'GET', `GlobalOptionSetDefinitions(Name='${name}')`)) as IDataObject;
		const options = (response.Options as IDataObject[]) ?? [];
		return {
			name,
			displayName: label(response.DisplayName as IDataObject, name),
			options: options.map((o) => ({ value: o.Value, label: label(o.Label as IDataObject, String(o.Value)) })),
		};
	}

	const entity = await resolveEntity.call(this, this.getNodeParameter('entity', i) as string, i);
	const attributeName = this.getNodeParameter('attribute', i) as string;
	const attributes = await getAttributes.call(this, entity.logicalName);
	const attribute = attributes.find((a) => a.logicalName === attributeName);
	if (!attribute) {
		throw new NodeOperationError(this.getNode(), `Column "${attributeName}" was not found`, { itemIndex: i });
	}
	if (attribute.attributeType === 'Boolean') {
		const response = (await dynamicsApiRequest.call(
			this,
			'GET',
			`EntityDefinitions(LogicalName='${entity.logicalName}')/Attributes(LogicalName='${attributeName}')/Microsoft.Dynamics.CRM.BooleanAttributeMetadata?$select=LogicalName&$expand=OptionSet`,
		)) as IDataObject;
		const optionSet = response.OptionSet as IDataObject;
		const option = (o: IDataObject) => ({ value: o.Value, label: label(o.Label as IDataObject, String(o.Value)) });
		return {
			entity: entity.logicalName,
			attribute: attributeName,
			type: attribute.attributeType,
			options: [option(optionSet.FalseOption as IDataObject), option(optionSet.TrueOption as IDataObject)],
		};
	}
	if (!attribute.options) {
		throw new NodeOperationError(this.getNode(), `Column "${attributeName}" is not a choice column`, { itemIndex: i });
	}
	return {
		entity: entity.logicalName,
		attribute: attributeName,
		type: attribute.attributeType,
		options: attribute.options as unknown as IDataObject[],
	};
}

async function listGlobalOptionSets(this: IExecuteFunctions): Promise<OperationResult> {
	const response = (await dynamicsApiRequest.call(this, 'GET', 'GlobalOptionSetDefinitions')) as IDataObject;
	return ((response.value as IDataObject[]) ?? []).map((set) => ({
		name: set.Name,
		displayName: label(set.DisplayName as IDataObject, String(set.Name)),
		optionSetType: set.OptionSetType,
		isCustom: set.IsCustomOptionSet,
		options: ((set.Options as IDataObject[]) ?? []).map((o) => ({
			value: o.Value,
			label: label(o.Label as IDataObject, String(o.Value)),
		})),
	}));
}

async function listOperations(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const kind = this.getNodeParameter('operationKind', i, 'all') as string;
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;
	const model = await getCsdl.call(this);
	const nameContains = String(filters.nameContains ?? '').toLowerCase();
	const boundEntity = String(filters.boundEntity ?? '').toLowerCase();
	return model.operations
		.filter((o) => kind === 'all' || o.kind === kind)
		.filter((o) => !filters.binding || filters.binding === 'any' || operationScope(o) === filters.binding)
		.filter((o) => !boundEntity || o.boundEntity === boundEntity)
		.filter((o) => !nameContains || o.name.toLowerCase().includes(nameContains))
		.map(describeOperation);
}

async function getOperation(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const kind = this.getNodeParameter('operationKind', i, 'action') as string;
	const name = (this.getNodeParameter('operationName', i) as string).trim();
	const model = await getCsdl.call(this);
	const matches = model.operations.filter((o) => o.kind === kind && o.name.toLowerCase() === name.toLowerCase());
	if (!matches.length) {
		throw new NodeOperationError(this.getNode(), `No ${kind} named "${name}" was found`, { itemIndex: i });
	}
	return matches.map(describeOperation);
}

async function clearMetadataCache(this: IExecuteFunctions): Promise<OperationResult> {
	const connection = await getConnection.call(this);
	for (const prefix of ['entities|', 'attributes|', 'relationships|', 'csdl|']) {
		clearCache(prefix);
	}
	return { cleared: true, organization: connection.baseUrl };
}

export const metadataOperations: Record<string, (this: IExecuteFunctions, i: number) => Promise<OperationResult>> = {
	clearCache: clearMetadataCache,
	getEntity,
	getOperation,
	getOptionSet,
	listAttributes,
	listEntities,
	listGlobalOptionSets,
	listOperations,
	listRelationships,
};
