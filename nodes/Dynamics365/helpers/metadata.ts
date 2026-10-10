import type { IDataObject } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	cached,
	dynamicsApiRequestAllItems,
	dynamicsApiRequestWithConnection,
	getConnection,
	type DynamicsContext,
} from '../transport';
import type { HttpResponse } from '../transport/httpClient';
import { parseCsdl, type CsdlModel } from './csdl';

const METADATA_TTL = 30 * 60_000;

export interface EntityInfo {
	logicalName: string;
	entitySetName: string;
	displayName: string;
	primaryIdAttribute: string;
	primaryNameAttribute: string;
	objectTypeCode: number;
	isActivity: boolean;
	isCustomEntity: boolean;
}

export interface OptionInfo {
	value: number;
	label: string;
	state?: number;
}

export interface AttributeInfo {
	logicalName: string;
	schemaName: string;
	attributeType: string;
	typeName: string;
	displayName: string;
	isValidForCreate: boolean;
	isValidForUpdate: boolean;
	isValidForRead: boolean;
	requiredLevel: string;
	isPrimaryId: boolean;
	isPrimaryName: boolean;
	attributeOf: string | null;
	targets?: string[];
	options?: OptionInfo[];
}

export interface RelationshipInfo {
	schemaName: string;
	kind: 'ManyToOne' | 'OneToMany' | 'ManyToMany';
	navigationProperty: string;
	relatedEntity: string;
	/** For ManyToOne: the lookup attribute on this entity. */
	referencingAttribute?: string;
	isCollection: boolean;
}

export const LOOKUP_TYPES = new Set(['Lookup', 'Customer', 'Owner']);
export const OPTION_TYPES = new Set(['Picklist', 'State', 'Status']);

export function label(value: IDataObject | undefined | null, fallback = ''): string {
	if (!value) return fallback;
	const user = value.UserLocalizedLabel as IDataObject | null | undefined;
	if (user?.Label) return String(user.Label);
	const labels = value.LocalizedLabels as IDataObject[] | undefined;
	return labels?.length ? String(labels[0].Label) : fallback;
}

async function metadataGet(this: DynamicsContext, resource: string): Promise<IDataObject> {
	const connection = await getConnection.call(this);
	return (await dynamicsApiRequestWithConnection.call(this, connection, 'GET', resource)) as IDataObject;
}

export async function getEntities(this: DynamicsContext): Promise<EntityInfo[]> {
	const connection = await getConnection.call(this);
	return await cached(`entities|${connection.cacheKey}`, METADATA_TTL, async () => {
		const values = await dynamicsApiRequestAllItems.call(this, 'EntityDefinitions', {
			qs: {
				$select:
					'LogicalName,EntitySetName,DisplayName,PrimaryIdAttribute,PrimaryNameAttribute,ObjectTypeCode,IsActivity,IsCustomEntity',
			},
		});
		return values
			.map((entity) => ({
				logicalName: String(entity.LogicalName),
				entitySetName: String(entity.EntitySetName ?? ''),
				displayName: label(entity.DisplayName as IDataObject, String(entity.LogicalName)),
				primaryIdAttribute: String(entity.PrimaryIdAttribute ?? ''),
				primaryNameAttribute: String(entity.PrimaryNameAttribute ?? ''),
				objectTypeCode: Number(entity.ObjectTypeCode ?? 0),
				isActivity: !!entity.IsActivity,
				isCustomEntity: !!entity.IsCustomEntity,
			}))
			.sort((a, b) => a.logicalName.localeCompare(b.logicalName));
	});
}

/**
 * Resolves an entity by logical name, entity set name or object type code.
 */
export async function resolveEntity(
	this: DynamicsContext,
	nameOrSet: string,
	itemIndex?: number,
): Promise<EntityInfo> {
	const value = String(nameOrSet ?? '').trim();
	if (!value) {
		throw new NodeOperationError(this.getNode(), 'No entity (table) was specified', { itemIndex });
	}
	const entities = await getEntities.call(this);
	const lower = value.toLowerCase();
	const entity =
		entities.find((e) => e.logicalName === lower) ??
		entities.find((e) => e.entitySetName.toLowerCase() === lower) ??
		entities.find((e) => String(e.objectTypeCode) === value);
	if (!entity) {
		throw new NodeOperationError(this.getNode(), `Entity (table) "${value}" was not found`, { itemIndex });
	}
	if (!entity.entitySetName) {
		throw new NodeOperationError(
			this.getNode(),
			`Entity "${entity.logicalName}" is not available through the Web API`,
			{ itemIndex },
		);
	}
	return entity;
}

function mapOptions(optionSet: IDataObject | undefined): OptionInfo[] {
	const options = (optionSet?.Options as IDataObject[]) ?? [];
	return options.map((option) => ({
		value: Number(option.Value),
		label: label(option.Label as IDataObject, String(option.Value)),
		...(option.State !== undefined && option.State !== null ? { state: Number(option.State) } : {}),
	}));
}

export async function getAttributes(this: DynamicsContext, logicalName: string): Promise<AttributeInfo[]> {
	const connection = await getConnection.call(this);
	return await cached(`attributes|${logicalName}|${connection.cacheKey}`, METADATA_TTL, async () => {
		const base = `EntityDefinitions(LogicalName='${logicalName}')/Attributes`;
		const optionQuery = (type: string) =>
			metadataGet
				.call(this, `${base}/Microsoft.Dynamics.CRM.${type}?$select=LogicalName&$expand=OptionSet($select=Options)`)
				.catch(() => ({ value: [] }) as IDataObject);

		const [all, lookups, picklists, states, statuses, multiSelects] = await Promise.all([
			metadataGet.call(
				this,
				`${base}?$select=LogicalName,SchemaName,AttributeType,AttributeTypeName,DisplayName,IsValidForCreate,IsValidForUpdate,IsValidForRead,RequiredLevel,IsPrimaryId,IsPrimaryName,AttributeOf`,
			),
			metadataGet.call(this, `${base}/Microsoft.Dynamics.CRM.LookupAttributeMetadata?$select=LogicalName,Targets`),
			optionQuery('PicklistAttributeMetadata'),
			optionQuery('StateAttributeMetadata'),
			optionQuery('StatusAttributeMetadata'),
			optionQuery('MultiSelectPicklistAttributeMetadata'),
		]);

		const targets = new Map<string, string[]>();
		for (const lookup of (lookups.value as IDataObject[]) ?? []) {
			targets.set(String(lookup.LogicalName), (lookup.Targets as string[]) ?? []);
		}
		const options = new Map<string, OptionInfo[]>();
		for (const result of [picklists, states, statuses, multiSelects]) {
			for (const attribute of (result.value as IDataObject[]) ?? []) {
				options.set(String(attribute.LogicalName), mapOptions(attribute.OptionSet as IDataObject));
			}
		}

		return ((all.value as IDataObject[]) ?? [])
			.map((attribute) => {
				const name = String(attribute.LogicalName);
				const info: AttributeInfo = {
					logicalName: name,
					schemaName: String(attribute.SchemaName ?? name),
					attributeType: String(attribute.AttributeType ?? ''),
					typeName: String((attribute.AttributeTypeName as IDataObject)?.Value ?? ''),
					displayName: label(attribute.DisplayName as IDataObject, name),
					isValidForCreate: !!attribute.IsValidForCreate,
					isValidForUpdate: !!attribute.IsValidForUpdate,
					isValidForRead: !!attribute.IsValidForRead,
					requiredLevel: String((attribute.RequiredLevel as IDataObject)?.Value ?? 'None'),
					isPrimaryId: !!attribute.IsPrimaryId,
					isPrimaryName: !!attribute.IsPrimaryName,
					attributeOf: (attribute.AttributeOf as string) ?? null,
				};
				if (targets.has(name)) info.targets = targets.get(name);
				if (options.has(name)) info.options = options.get(name);
				return info;
			})
			.sort((a, b) => a.logicalName.localeCompare(b.logicalName));
	});
}

export async function getRelationships(this: DynamicsContext, logicalName: string): Promise<RelationshipInfo[]> {
	const connection = await getConnection.call(this);
	return await cached(`relationships|${logicalName}|${connection.cacheKey}`, METADATA_TTL, async () => {
		const base = `EntityDefinitions(LogicalName='${logicalName}')`;
		const [manyToOne, oneToMany, manyToMany] = await Promise.all([
			metadataGet.call(
				this,
				`${base}/ManyToOneRelationships?$select=SchemaName,ReferencedEntity,ReferencingAttribute,ReferencingEntityNavigationPropertyName`,
			),
			metadataGet.call(
				this,
				`${base}/OneToManyRelationships?$select=SchemaName,ReferencingEntity,ReferencingAttribute,ReferencedEntityNavigationPropertyName`,
			),
			metadataGet.call(
				this,
				`${base}/ManyToManyRelationships?$select=SchemaName,Entity1LogicalName,Entity2LogicalName,Entity1NavigationPropertyName,Entity2NavigationPropertyName`,
			),
		]);

		const relationships: RelationshipInfo[] = [];
		for (const r of (manyToOne.value as IDataObject[]) ?? []) {
			if (!r.ReferencingEntityNavigationPropertyName) continue;
			relationships.push({
				schemaName: String(r.SchemaName),
				kind: 'ManyToOne',
				navigationProperty: String(r.ReferencingEntityNavigationPropertyName),
				relatedEntity: String(r.ReferencedEntity),
				referencingAttribute: String(r.ReferencingAttribute),
				isCollection: false,
			});
		}
		for (const r of (oneToMany.value as IDataObject[]) ?? []) {
			if (!r.ReferencedEntityNavigationPropertyName) continue;
			relationships.push({
				schemaName: String(r.SchemaName),
				kind: 'OneToMany',
				navigationProperty: String(r.ReferencedEntityNavigationPropertyName),
				relatedEntity: String(r.ReferencingEntity),
				isCollection: true,
			});
		}
		for (const r of (manyToMany.value as IDataObject[]) ?? []) {
			const sides: Array<[string, string, string]> = [
				[String(r.Entity1LogicalName), String(r.Entity1NavigationPropertyName ?? ''), String(r.Entity2LogicalName)],
				[String(r.Entity2LogicalName), String(r.Entity2NavigationPropertyName ?? ''), String(r.Entity1LogicalName)],
			];
			for (const [entity, navigationProperty, relatedEntity] of sides) {
				if (entity !== logicalName || !navigationProperty) continue;
				if (relationships.some((x) => x.navigationProperty === navigationProperty)) continue;
				relationships.push({
					schemaName: String(r.SchemaName),
					kind: 'ManyToMany',
					navigationProperty,
					relatedEntity,
					isCollection: true,
				});
			}
		}
		return relationships.sort((a, b) => a.navigationProperty.localeCompare(b.navigationProperty));
	});
}

export async function findRelationship(
	this: DynamicsContext,
	logicalName: string,
	navigationProperty: string,
	itemIndex?: number,
): Promise<RelationshipInfo> {
	const relationships = await getRelationships.call(this, logicalName);
	const lower = navigationProperty.toLowerCase();
	const relationship =
		relationships.find((r) => r.navigationProperty === navigationProperty) ??
		relationships.find((r) => r.navigationProperty.toLowerCase() === lower) ??
		relationships.find((r) => r.schemaName.toLowerCase() === lower);
	if (!relationship) {
		throw new NodeOperationError(
			this.getNode(),
			`Relationship (navigation property) "${navigationProperty}" was not found on entity "${logicalName}"`,
			{ itemIndex },
		);
	}
	return relationship;
}

export async function getCsdl(this: DynamicsContext): Promise<CsdlModel> {
	const connection = await getConnection.call(this);
	return await cached(`csdl|${connection.cacheKey}`, 60 * 60_000, async () => {
		const response = (await dynamicsApiRequestWithConnection.call(this, connection, 'GET', '$metadata', undefined, {
			headers: { Accept: 'application/xml' },
			fullResponse: true,
			timeout: 300_000,
		})) as HttpResponse;
		return parseCsdl(response.body.toString('utf8'));
	});
}

/** Converts logical attribute names to Web API property names (lookups -> _name_value). */
export async function toWebApiPropertyNames(
	this: DynamicsContext,
	logicalName: string,
	names: string[],
): Promise<string[]> {
	if (!names.length) return names;
	const attributes = await getAttributes.call(this, logicalName);
	const byName = new Map(attributes.map((a) => [a.logicalName, a]));
	return names.map((name) => {
		const attribute = byName.get(name);
		return attribute && LOOKUP_TYPES.has(attribute.attributeType) ? `_${name}_value` : name;
	});
}
