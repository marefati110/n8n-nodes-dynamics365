import type { FieldType, ILoadOptionsFunctions, ResourceMapperField, ResourceMapperFields } from 'n8n-workflow';
import { describeType, findOperation, unwrapCollection, type OperationScope } from '../helpers/csdl';
import { getAttributes, getCsdl, LOOKUP_TYPES, resolveEntity, type AttributeInfo } from '../helpers/metadata';

function currentString(context: ILoadOptionsFunctions, name: string): string {
	try {
		const value = context.getCurrentNodeParameter(name);
		return typeof value === 'string' ? value : '';
	} catch {
		return '';
	}
}

const EXCLUDED_TYPES = new Set(['PartyList', 'CalendarRules', 'EntityName', 'ManagedProperty']);

function attributeFieldType(attribute: AttributeInfo): FieldType {
	switch (attribute.attributeType) {
		case 'Integer':
		case 'BigInt':
		case 'Decimal':
		case 'Double':
		case 'Money':
			return 'number';
		case 'Boolean':
			return 'boolean';
		case 'DateTime':
			return 'dateTime';
		case 'Picklist':
		case 'State':
		case 'Status':
			return attribute.options?.length ? 'options' : 'number';
		default:
			return 'string';
	}
}

function isMappable(attribute: AttributeInfo, operation: string): boolean {
	// Image columns are reported as an attribute of their *id column but are writable themselves.
	if (attribute.attributeOf && attribute.typeName !== 'ImageType') return false;
	if (EXCLUDED_TYPES.has(attribute.attributeType)) return false;
	if (attribute.attributeType === 'Virtual' && !['MultiSelectPicklistType', 'ImageType'].includes(attribute.typeName)) {
		return false;
	}
	if (operation === 'create') return attribute.isValidForCreate;
	if (operation === 'update') return attribute.isValidForUpdate;
	return attribute.isValidForCreate || attribute.isValidForUpdate;
}

export async function getRecordFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const entityName = currentString(this, 'entity');
	if (!entityName) return { fields: [] };
	const operation = currentString(this, 'operation') || 'create';
	const entity = await resolveEntity.call(this, entityName);
	const attributes = await getAttributes.call(this, entity.logicalName);

	const fields: ResourceMapperField[] = attributes
		.filter((a) => isMappable(a, operation))
		.map((attribute) => {
			let displayName = `${attribute.displayName} (${attribute.logicalName})`;
			if (LOOKUP_TYPES.has(attribute.attributeType)) {
				displayName += ` → ${(attribute.targets ?? []).join(' | ')}`;
			}
			const type = attributeFieldType(attribute);
			const field: ResourceMapperField = {
				id: attribute.logicalName,
				displayName,
				required: operation === 'create' && attribute.requiredLevel === 'ApplicationRequired' && !attribute.isPrimaryId,
				defaultMatch: attribute.isPrimaryId,
				canBeUsedToMatch: attribute.isPrimaryId,
				display: true,
				type,
			};
			if (type === 'options') {
				field.options = (attribute.options ?? []).map((o) => ({ name: `${o.label} (${o.value})`, value: o.value }));
			}
			return field;
		})
		.sort((a, b) => Number(b.required) - Number(a.required) || a.displayName.localeCompare(b.displayName));

	return { fields };
}

export async function getOperationParameters(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
	const operationName = currentString(this, 'operationName');
	if (!operationName) return { fields: [] };
	const kind = currentString(this, 'operation') === 'executeFunction' ? 'function' : 'action';
	const scope = (currentString(this, 'bindingScope') || 'unbound') as OperationScope;
	const entityName = currentString(this, 'entity');
	const entity = scope !== 'unbound' && entityName ? (await resolveEntity.call(this, entityName)).logicalName : undefined;

	const model = await getCsdl.call(this);
	const operation = findOperation(model, kind, operationName, scope, entity);
	if (!operation) return { fields: [] };

	const fields: ResourceMapperField[] = operation.parameters.map((parameter) => {
		const { isCollection, itemType } = unwrapCollection(parameter.type);
		const enumType = model.enums.get(itemType);
		let type: FieldType = 'string';
		let options: ResourceMapperField['options'];
		let hint = describeType(parameter.type);
		if (isCollection) {
			type = 'string';
			hint += ' – JSON array or comma-separated';
		} else if (enumType && !enumType.isFlags) {
			type = 'options';
			options = enumType.members.map((m) => ({ name: m.name, value: m.name }));
		} else if (enumType) {
			hint += ` – comma-separated: ${enumType.members.map((m) => m.name).join(', ')}`;
		} else if (model.entityTypes.has(itemType)) {
			hint += ' – reference like "accounts(GUID)", "account:GUID" or JSON object';
		} else if (model.complexTypes.has(itemType)) {
			type = 'object';
			hint += ' – JSON object';
		} else {
			switch (itemType) {
				case 'Edm.Int16':
				case 'Edm.Int32':
				case 'Edm.Int64':
				case 'Edm.Decimal':
				case 'Edm.Double':
					type = 'number';
					break;
				case 'Edm.Boolean':
					type = 'boolean';
					break;
				case 'Edm.DateTimeOffset':
					type = 'dateTime';
					break;
			}
		}
		const required = !parameter.nullable && !parameter.optional;
		return {
			id: parameter.name,
			displayName: `${parameter.name} (${hint})`,
			required,
			defaultMatch: false,
			display: true,
			type,
			...(options ? { options } : {}),
		};
	});
	return { fields };
}
