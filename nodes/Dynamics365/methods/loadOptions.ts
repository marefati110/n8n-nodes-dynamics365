import type { IDataObject, ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { dynamicsApiRequestAllItems } from '../transport';
import { describeType, findOperations, type OperationScope } from '../helpers/csdl';
import { getAttributes, getCsdl, getEntities, getRelationships, label, resolveEntity } from '../helpers/metadata';

function currentString(context: ILoadOptionsFunctions, name: string): string {
	try {
		const value = context.getCurrentNodeParameter(name);
		return typeof value === 'string' ? value : '';
	} catch {
		return '';
	}
}

function byName(a: INodePropertyOptions, b: INodePropertyOptions) {
	return a.name.localeCompare(b.name);
}

export async function getEntityOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const entities = await getEntities.call(this);
	return entities
		.filter((e) => e.entitySetName)
		.map((e) => ({
			name: e.displayName && e.displayName !== e.logicalName ? `${e.displayName} (${e.logicalName})` : e.logicalName,
			value: e.logicalName,
			description: `Entity set: ${e.entitySetName}`,
		}))
		.sort(byName);
}

async function attributeOptions(
	context: ILoadOptionsFunctions,
	filter: (a: Awaited<ReturnType<typeof getAttributes>>[number]) => boolean,
): Promise<INodePropertyOptions[]> {
	const entity = currentString(context, 'entity');
	if (!entity) return [];
	const attributes = await getAttributes.call(context, (await resolveEntity.call(context, entity)).logicalName);
	return attributes
		.filter(filter)
		.map((a) => ({
			name: `${a.displayName} (${a.logicalName})`,
			value: a.logicalName,
			description: `${a.attributeType}${a.targets?.length ? ` → ${a.targets.join(', ')}` : ''}`,
		}))
		.sort(byName);
}

export async function getAttributeOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await attributeOptions(this, (a) => a.isValidForRead && (!a.attributeOf || a.typeName === 'ImageType'));
}

export async function getAllAttributeOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await attributeOptions(this, () => true);
}

export async function getBinaryAttributeOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await attributeOptions(
		this,
		(a) => ['ImageType', 'FileType'].includes(a.typeName),
	);
}

export async function getRelationshipOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const entity = currentString(this, 'entity');
	if (!entity) return [];
	const relationships = await getRelationships.call(this, (await resolveEntity.call(this, entity)).logicalName);
	return relationships
		.map((r) => ({
			name: `${r.navigationProperty} → ${r.relatedEntity}`,
			value: r.navigationProperty,
			description: `${r.kind} (${r.schemaName})${r.isCollection ? '' : ' – single-valued'}`,
		}))
		.sort(byName);
}

export async function getStateCodeOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const entity = currentString(this, 'entity');
	if (!entity) return [];
	const attributes = await getAttributes.call(this, (await resolveEntity.call(this, entity)).logicalName);
	const state = attributes.find((a) => a.attributeType === 'State');
	return (state?.options ?? []).map((o) => ({ name: `${o.label} (${o.value})`, value: o.value }));
}

export async function getStatusCodeOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const entity = currentString(this, 'entity');
	if (!entity) return [];
	const attributes = await getAttributes.call(this, (await resolveEntity.call(this, entity)).logicalName);
	const status = attributes.find((a) => a.attributeType === 'Status');
	let stateCode: number | undefined;
	try {
		const value = this.getCurrentNodeParameter('stateCode');
		if (value !== undefined && value !== '') stateCode = Number(value);
	} catch {}
	const options = (status?.options ?? [])
		.filter((o) => stateCode === undefined || o.state === undefined || o.state === stateCode)
		.map((o) => ({ name: `${o.label} (${o.value})`, value: o.value }));
	return [{ name: 'Default for State', value: -1 }, ...options];
}

async function operationOptions(
	context: ILoadOptionsFunctions,
	kind: 'action' | 'function',
): Promise<INodePropertyOptions[]> {
	const scope = (currentString(context, 'bindingScope') || 'unbound') as OperationScope;
	const entityParameter = currentString(context, 'entity');
	let entity: string | undefined;
	if (scope !== 'unbound' && entityParameter) {
		entity = (await resolveEntity.call(context, entityParameter)).logicalName;
	}
	const model = await getCsdl.call(context);
	const seen = new Set<string>();
	return findOperations(model, kind, scope, entity)
		.filter((o) => (seen.has(o.name) ? false : (seen.add(o.name), true)))
		.map((o) => {
			const parameters = o.parameters
				.map((p) => `${p.name}: ${describeType(p.type)}${p.nullable || p.optional ? '?' : ''}`)
				.join(', ');
			const bound = o.isBound ? ` [bound to ${o.boundToCollection ? `collection of ${o.boundEntity}` : o.boundEntity}]` : '';
			return {
				name: o.name,
				value: o.name,
				description: `(${parameters})${o.returnType ? ` → ${describeType(o.returnType)}` : ''}${bound}`,
			};
		})
		.sort(byName);
}

export async function getActionOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await operationOptions(this, 'action');
}

export async function getFunctionOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	return await operationOptions(this, 'function');
}

export async function getViewOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const entity = currentString(this, 'entity');
	if (!entity) return [];
	const logicalName = (await resolveEntity.call(this, entity)).logicalName;
	const viewType = currentString(this, 'viewType') || 'savedquery';
	const isSystem = viewType === 'savedquery';
	const views = await dynamicsApiRequestAllItems.call(this, isSystem ? 'savedqueries' : 'userqueries', {
		qs: {
			$select: isSystem ? 'name,savedqueryid,querytype' : 'name,userqueryid,querytype',
			$filter: `returnedtypecode eq '${logicalName}'${isSystem ? ' and statecode eq 0' : ''}`,
			$orderby: 'name asc',
		},
	});
	return views.map((v) => ({
		name: String(v.name),
		value: String(isSystem ? v.savedqueryid : v.userqueryid),
		description: `Query type ${v.querytype}`,
	}));
}

export async function getWorkflowOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const workflows = await dynamicsApiRequestAllItems.call(this, 'workflows', {
		qs: {
			$select: 'name,workflowid,primaryentity',
			$filter: 'category eq 0 and type eq 1 and ondemand eq true and statecode eq 1',
			$orderby: 'name asc',
		},
	});
	return workflows.map((w) => ({
		name: `${w.name} (${w.primaryentity})`,
		value: String(w.workflowid),
	}));
}

export async function getGlobalOptionSetOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const sets = await dynamicsApiRequestAllItems.call(this, 'GlobalOptionSetDefinitions', {
		qs: { $select: 'Name,DisplayName' },
	});
	return sets
		.map((s) => {
			const display = label(s.DisplayName as IDataObject, String(s.Name));
			return { name: display === s.Name ? String(s.Name) : `${display} (${s.Name})`, value: String(s.Name) };
		})
		.sort(byName);
}

export async function getUserOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const users = await dynamicsApiRequestAllItems.call(this, 'systemusers', {
		qs: { $select: 'fullname,domainname,systemuserid', $filter: 'isdisabled eq false', $orderby: 'fullname asc' },
	});
	return users.map((u) => ({
		name: `${u.fullname}${u.domainname ? ` (${u.domainname})` : ''}`,
		value: String(u.systemuserid),
	}));
}

export async function getTeamOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
	const teams = await dynamicsApiRequestAllItems.call(this, 'teams', {
		qs: { $select: 'name,teamid', $orderby: 'name asc' },
	});
	return teams.map((t) => ({ name: String(t.name), value: String(t.teamid) }));
}
