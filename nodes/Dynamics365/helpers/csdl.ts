/**
 * Minimal CSDL ($metadata) parser. It only extracts what the node needs — entity sets,
 * enum types, complex type names and the actions/functions with their parameters —
 * using a regex scanner, which is fast enough for multi-megabyte documents and avoids
 * an XML parser dependency.
 */

export const NAMESPACE = 'Microsoft.Dynamics.CRM';

export interface CsdlParameter {
	name: string;
	type: string;
	nullable: boolean;
	optional: boolean;
}

export interface CsdlOperation {
	kind: 'action' | 'function';
	name: string;
	isBound: boolean;
	/** Binding parameter name (e.g. "entity"). */
	bindingParameter?: string;
	/** Entity logical name the operation is bound to, e.g. "lead" or "crmbaseentity". */
	boundEntity?: string;
	boundToCollection: boolean;
	/** Parameters excluding the binding parameter. */
	parameters: CsdlParameter[];
	returnType?: string;
	/** Exposed as an action/function import (callable unbound). */
	isImport: boolean;
}

export interface CsdlEnum {
	name: string;
	isFlags: boolean;
	members: Array<{ name: string; value: number }>;
}

export interface CsdlModel {
	entitySets: Map<string, string>;
	entityTypeToSet: Map<string, string>;
	entityTypes: Set<string>;
	complexTypes: Set<string>;
	enums: Map<string, CsdlEnum>;
	operations: CsdlOperation[];
}

function decodeXml(value: string): string {
	return value
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
		.replace(/&amp;/g, '&');
}

function parseAttributes(source: string): Record<string, string> {
	const attributes: Record<string, string> = {};
	const pattern = /([\w:.]+)\s*=\s*"([^"]*)"/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(source))) attributes[match[1]] = decodeXml(match[2]);
	return attributes;
}

/** Removes the namespace/alias prefix: "mscrm.account" -> "account". Keeps Edm.* and Collection(). */
export function shortTypeName(type: string): string {
	const collection = /^Collection\((.*)\)$/.exec(type);
	if (collection) return `Collection(${shortTypeName(collection[1])})`;
	if (type.startsWith('Edm.')) return type;
	return type.replace(/^(mscrm|Microsoft\.Dynamics\.CRM)\./, '');
}

export function unwrapCollection(type: string): { isCollection: boolean; itemType: string } {
	const match = /^Collection\((.*)\)$/.exec(type);
	return match ? { isCollection: true, itemType: match[1] } : { isCollection: false, itemType: type };
}

function parseOperations(xml: string, kind: 'action' | 'function'): CsdlOperation[] {
	const tag = kind === 'action' ? 'Action' : 'Function';
	const pattern = new RegExp(`<${tag}\\s([^>]*?)(/>|>([\\s\\S]*?)</${tag}>)`, 'g');
	const operations: CsdlOperation[] = [];
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(xml))) {
		const attributes = parseAttributes(match[1]);
		const inner = match[3] ?? '';
		const isBound = attributes.IsBound === 'true';

		const parameters: CsdlParameter[] = [];
		const parameterPattern = /<Parameter\s([^>]*?)(\/>|>([\s\S]*?)<\/Parameter>)/g;
		let parameterMatch: RegExpExecArray | null;
		while ((parameterMatch = parameterPattern.exec(inner))) {
			const parameterAttributes = parseAttributes(parameterMatch[1]);
			parameters.push({
				name: parameterAttributes.Name,
				type: shortTypeName(parameterAttributes.Type),
				nullable: parameterAttributes.Nullable !== 'false',
				optional: (parameterMatch[3] ?? '').includes('OptionalParameter'),
			});
		}
		const returnMatch = /<ReturnType\s([^>]*?)\/?>/.exec(inner);

		const operation: CsdlOperation = {
			kind,
			name: attributes.Name,
			isBound,
			boundToCollection: false,
			parameters,
			returnType: returnMatch ? shortTypeName(parseAttributes(returnMatch[1]).Type) : undefined,
			isImport: false,
		};
		if (isBound && parameters.length) {
			const binding = parameters.shift() as CsdlParameter;
			const { isCollection, itemType } = unwrapCollection(binding.type);
			operation.bindingParameter = binding.name;
			operation.boundEntity = itemType;
			operation.boundToCollection = isCollection;
		}
		operations.push(operation);
	}
	return operations;
}

export function parseCsdl(xml: string): CsdlModel {
	const entitySets = new Map<string, string>();
	const entityTypeToSet = new Map<string, string>();
	const setPattern = /<EntitySet\s([^>]*?)\/?>/g;
	let match: RegExpExecArray | null;
	while ((match = setPattern.exec(xml))) {
		const attributes = parseAttributes(match[1]);
		const type = shortTypeName(attributes.EntityType);
		entitySets.set(attributes.Name, type);
		if (!entityTypeToSet.has(type)) entityTypeToSet.set(type, attributes.Name);
	}

	const entityTypes = new Set<string>();
	const entityPattern = /<EntityType\s+Name="([^"]+)"/g;
	while ((match = entityPattern.exec(xml))) entityTypes.add(match[1]);

	const complexTypes = new Set<string>();
	const complexPattern = /<ComplexType\s+Name="([^"]+)"/g;
	while ((match = complexPattern.exec(xml))) complexTypes.add(match[1]);

	const enums = new Map<string, CsdlEnum>();
	const enumPattern = /<EnumType\s([^>]*?)>([\s\S]*?)<\/EnumType>/g;
	while ((match = enumPattern.exec(xml))) {
		const attributes = parseAttributes(match[1]);
		const members: CsdlEnum['members'] = [];
		const memberPattern = /<Member\s([^>]*?)\/?>/g;
		let memberMatch: RegExpExecArray | null;
		while ((memberMatch = memberPattern.exec(match[2]))) {
			const memberAttributes = parseAttributes(memberMatch[1]);
			members.push({ name: memberAttributes.Name, value: Number(memberAttributes.Value) });
		}
		enums.set(attributes.Name, { name: attributes.Name, isFlags: attributes.IsFlags === 'true', members });
	}

	const operations = [...parseOperations(xml, 'action'), ...parseOperations(xml, 'function')];

	const imports = new Set<string>();
	const importPattern = /<(?:ActionImport|FunctionImport)\s([^>]*?)\/?>/g;
	while ((match = importPattern.exec(xml))) {
		const attributes = parseAttributes(match[1]);
		imports.add(shortTypeName(attributes.Action ?? attributes.Function ?? ''));
	}
	for (const operation of operations) {
		operation.isImport = !operation.isBound && imports.has(operation.name);
	}

	return { entitySets, entityTypeToSet, entityTypes, complexTypes, enums, operations };
}

export type OperationScope = 'unbound' | 'entity' | 'collection';

export function operationScope(operation: CsdlOperation): OperationScope {
	if (!operation.isBound) return 'unbound';
	return operation.boundToCollection ? 'collection' : 'entity';
}

/** Finds operations by name/scope, honoring operations bound to the abstract base entity. */
export function findOperations(
	model: CsdlModel,
	kind: 'action' | 'function',
	scope: OperationScope,
	entity?: string,
): CsdlOperation[] {
	return model.operations.filter((operation) => {
		if (operation.kind !== kind || operationScope(operation) !== scope) return false;
		if (scope === 'unbound') return true;
		if (!entity) return true;
		return operation.boundEntity === entity || operation.boundEntity === 'crmbaseentity';
	});
}

export function findOperation(
	model: CsdlModel,
	kind: 'action' | 'function',
	name: string,
	scope: OperationScope,
	entity?: string,
): CsdlOperation | undefined {
	const candidates = findOperations(model, kind, scope, entity).filter((o) => o.name === name);
	return candidates.find((o) => o.boundEntity === entity) ?? candidates[0];
}

export function describeType(type: string): string {
	return shortTypeName(type).replace(/^Edm\./, '');
}
