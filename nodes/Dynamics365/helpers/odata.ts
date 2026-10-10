import type { IDataObject } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { dynamicsApiRequest, type DynamicsContext } from '../transport';
import { NAMESPACE, unwrapCollection, type CsdlModel, type CsdlOperation, type CsdlParameter } from './csdl';
import {
	getAttributes,
	getEntities,
	getRelationships,
	LOOKUP_TYPES,
	resolveEntity,
	type AttributeInfo,
	type EntityInfo,
} from './metadata';

const GUID_PATTERN = /^\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;

export function isGuid(value: unknown): boolean {
	return typeof value === 'string' && GUID_PATTERN.test(value.trim());
}

export function normalizeGuid(value: string): string {
	const match = GUID_PATTERN.exec(String(value).trim());
	return match ? match[1].toLowerCase() : String(value).trim();
}

/** Escapes a string for use inside an OData single-quoted literal. */
export function quoteODataString(value: string): string {
	return `'${String(value).replace(/'/g, "''")}'`;
}

const TEXT_ATTRIBUTE_TYPES = new Set(['String', 'Memo']);
const NUMERIC_ATTRIBUTE_TYPES = new Set(['Integer', 'BigInt', 'Decimal', 'Double', 'Money', 'Picklist', 'State', 'Status']);

/**
 * Builds the key segment of a record URL: "(guid)" for an ID or "(key1='a',key2=5)" for an
 * alternate key. Numeric alternate key columns are left unquoted based on metadata.
 */
export async function buildKeySegment(
	this: DynamicsContext,
	entity: EntityInfo,
	id: string | undefined,
	alternateKeys: Array<{ key: string; value: unknown }> | undefined,
	itemIndex?: number,
): Promise<string> {
	if (alternateKeys?.length) {
		const attributes = await getAttributes.call(this, entity.logicalName);
		const byName = new Map(attributes.map((a) => [a.logicalName, a]));
		const parts = alternateKeys.map(({ key, value }) => {
			const attribute = byName.get(key);
			if (attribute && LOOKUP_TYPES.has(attribute.attributeType)) return `_${key}_value=${normalizeGuid(String(value))}`;
			if (attribute && NUMERIC_ATTRIBUTE_TYPES.has(attribute.attributeType)) return `${key}=${value}`;
			if (attribute?.attributeType === 'Uniqueidentifier') return `${key}=${normalizeGuid(String(value))}`;
			if (attribute?.attributeType === 'Boolean') return `${key}=${String(value).toLowerCase()}`;
			return `${key}=${quoteODataString(String(value))}`;
		});
		return `(${encodeURIComponent(parts.join(',')).replace(/%3D/g, '=').replace(/%2C/g, ',').replace(/%27/g, "'")})`;
	}
	if (!id || !String(id).trim()) {
		throw new NodeOperationError(this.getNode(), 'Record ID is required', { itemIndex });
	}
	const raw = String(id).trim();
	if (isGuid(raw)) return `(${normalizeGuid(raw)})`;
	// Allow callers to pass a ready-made key such as "accountnumber='A1'".
	if (raw.includes('=')) return `(${raw.replace(/^\(|\)$/g, '')})`;
	throw new NodeOperationError(this.getNode(), `"${raw}" is not a valid record ID (GUID expected)`, { itemIndex });
}

export interface EntityReference {
	/** Logical name or entity set name, as given. */
	entity?: string;
	id: string;
}

/**
 * Parses the many ways a record reference can be written:
 * GUID, "accounts(GUID)", "/accounts(GUID)", full URL, "account:GUID",
 * or an object such as { id, entity } / { "@odata.type": "...account", accountid: "..." }.
 */
export function parseEntityReference(value: unknown): EntityReference | undefined {
	if (value === null || value === undefined || value === '') return undefined;
	if (typeof value === 'object') {
		const obj = value as IDataObject;
		const id = obj.id ?? obj.Id ?? obj.ID ?? obj.value;
		const entity = obj.entity ?? obj.entityType ?? obj.logicalName ?? obj.LogicalName ?? obj.entitySet;
		if (id && isGuid(String(id))) return { id: normalizeGuid(String(id)), entity: entity ? String(entity) : undefined };
		const odataId = obj['@odata.id'];
		if (typeof odataId === 'string') return parseEntityReference(odataId);
		return undefined;
	}
	const text = String(value).trim();
	if (isGuid(text)) return { id: normalizeGuid(text) };
	const urlMatch = /(?:^|\/)([A-Za-z_][\w]*)\((\{?[0-9a-fA-F-]{36}\}?)\)\/?$/.exec(text);
	if (urlMatch) return { entity: urlMatch[1], id: normalizeGuid(urlMatch[2]) };
	const colonMatch = /^([A-Za-z_][\w]*)\s*[:/,]\s*(\{?[0-9a-fA-F-]{36}\}?)$/.exec(text);
	if (colonMatch) return { entity: colonMatch[1], id: normalizeGuid(colonMatch[2]) };
	return undefined;
}

function looksLikeJson(value: unknown): value is string {
	return typeof value === 'string' && /^\s*[[{]/.test(value);
}

export function parseJsonParameter(
	this: DynamicsContext,
	value: unknown,
	name: string,
	itemIndex?: number,
): any {
	if (typeof value !== 'string') return value;
	if (!value.trim()) return undefined;
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new NodeOperationError(this.getNode(), `Parameter "${name}" contains invalid JSON: ${(error as Error).message}`, {
			itemIndex,
		});
	}
}

/**
 * Converts field values keyed by logical name into a Web API request body:
 * lookups become "nav@odata.bind" references, multi-select option sets become
 * comma-separated strings, and keys already in Web API form are kept as they are.
 */
/**
 * Coerces string input (expressions, auto-mapped input data) to the column's type; the Web
 * API rejects e.g. "100000000" for an option set column.
 */
export function convertAttributeValue(attribute: AttributeInfo, value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const text = value.trim();
	switch (attribute.attributeType) {
		case 'Integer':
		case 'BigInt':
		case 'Picklist':
		case 'State':
		case 'Status':
			return text !== '' && /^-?\d+$/.test(text) ? parseInt(text, 10) : value;
		case 'Decimal':
		case 'Double':
		case 'Money':
			return text !== '' && !isNaN(Number(text)) ? Number(text) : value;
		case 'Boolean':
			if (['true', '1', 'yes'].includes(text.toLowerCase())) return true;
			if (['false', '0', 'no'].includes(text.toLowerCase())) return false;
			return value;
		default:
			return value;
	}
}

export interface RecordPayload {
	body: IDataObject;
	/** Lookup columns (logical names) to clear after/before the write. */
	clearLookups: string[];
	/** Navigation properties to clear, from "nav@odata.bind": null in raw JSON bodies. */
	clearNavigationProperties: string[];
}

/** Moves "nav@odata.bind": null entries out of a body: the Web API needs DELETE …/nav/$ref for those. */
export function extractNullBinds(body: IDataObject): { body: IDataObject; navigationProperties: string[] } {
	const result: IDataObject = {};
	const navigationProperties: string[] = [];
	for (const [key, value] of Object.entries(body)) {
		if (key.endsWith('@odata.bind') && value === null) navigationProperties.push(key.slice(0, -'@odata.bind'.length));
		else result[key] = value;
	}
	return { body: result, navigationProperties };
}

export async function buildRecordBody(
	this: DynamicsContext,
	entity: EntityInfo,
	values: IDataObject,
	mode: 'create' | 'update',
	itemIndex?: number,
): Promise<RecordPayload> {
	const body: IDataObject = {};
	const clearLookups: string[] = [];
	const keys = Object.keys(values);
	if (!keys.length) return { body, clearLookups, clearNavigationProperties: [] };

	const attributes = await getAttributes.call(this, entity.logicalName);
	const byName = new Map<string, AttributeInfo>(attributes.map((a) => [a.logicalName, a]));
	let relationshipsPromise: ReturnType<typeof getRelationships> | undefined;

	for (const key of keys) {
		const value = values[key];
		if (key.includes('@') || key.startsWith('_') || !byName.has(key)) {
			body[key] = value;
			continue;
		}
		const attribute = byName.get(key) as AttributeInfo;
		if (value === '' && !TEXT_ATTRIBUTE_TYPES.has(attribute.attributeType)) continue;

		if (LOOKUP_TYPES.has(attribute.attributeType)) {
			relationshipsPromise ??= getRelationships.call(this, entity.logicalName);
			const relationships = await relationshipsPromise;
			const candidates = relationships.filter(
				(r) => r.kind === 'ManyToOne' && r.referencingAttribute === attribute.logicalName,
			);

			if (value === null || value === undefined || value === '') {
				if (mode === 'update' && value === null) clearLookups.push(attribute.logicalName);
				continue;
			}

			const reference = parseEntityReference(value);
			if (!reference) {
				throw new NodeOperationError(
					this.getNode(),
					`Invalid value for lookup "${key}": expected a GUID or a reference like "accounts(GUID)"`,
					{ itemIndex },
				);
			}
			const targets = attribute.targets ?? [];
			let target: EntityInfo;
			if (reference.entity) {
				target = await resolveEntity.call(this, reference.entity, itemIndex);
			} else if (targets.length === 1) {
				target = await resolveEntity.call(this, targets[0], itemIndex);
			} else if (attribute.attributeType === 'Owner') {
				target = await resolveEntity.call(this, 'systemuser', itemIndex);
			} else {
				throw new NodeOperationError(
					this.getNode(),
					`Lookup "${key}" can point to ${targets.join(', ')}. Specify the table, e.g. "${
						targets[0]
					}:${reference.id}" or "${targets[0]}s(${reference.id})"`,
					{ itemIndex },
				);
			}
			const relationship =
				candidates.find((r) => r.relatedEntity === target.logicalName) ?? (candidates.length === 1 ? candidates[0] : undefined);
			const navigationProperty = relationship?.navigationProperty ?? attribute.logicalName;
			body[`${navigationProperty}@odata.bind`] = `/${target.entitySetName}(${reference.id})`;
			continue;
		}

		if (attribute.attributeType === 'Virtual' && attribute.typeName === 'MultiSelectPicklistType') {
			body[key] = Array.isArray(value) ? value.join(',') : value;
			continue;
		}
		if (attribute.attributeType === 'Uniqueidentifier' && typeof value === 'string') {
			body[key] = normalizeGuid(value);
			continue;
		}
		body[key] = convertAttributeValue(attribute, value) as IDataObject;
	}
	const extracted = extractNullBinds(body);
	return { body: extracted.body, clearLookups, clearNavigationProperties: extracted.navigationProperties };
}

/**
 * Clears lookup values with DELETE …/nav/$ref (setting "@odata.bind" to null is rejected
 * by the 9.x Web API). For multi-table lookups the currently referenced table is looked up
 * first so only the navigation property that is actually set gets cleared.
 */
export async function clearLookupValues(
	this: DynamicsContext,
	entity: EntityInfo,
	recordPath: string,
	payload: Pick<RecordPayload, 'clearLookups' | 'clearNavigationProperties'>,
	headers: Record<string, string>,
	itemIndex?: number,
): Promise<void> {
	const navigationProperties = new Set(payload.clearNavigationProperties);
	if (payload.clearLookups.length) {
		const relationships = await getRelationships.call(this, entity.logicalName);
		const polymorphic: Array<{ attribute: string; candidates: typeof relationships }> = [];
		for (const attribute of payload.clearLookups) {
			const candidates = relationships.filter((r) => r.kind === 'ManyToOne' && r.referencingAttribute === attribute);
			if (candidates.length === 1) navigationProperties.add(candidates[0].navigationProperty);
			else if (candidates.length > 1) polymorphic.push({ attribute, candidates });
		}
		if (polymorphic.length) {
			const current = (await dynamicsApiRequest.call(this, 'GET', recordPath, undefined, {
				qs: { $select: polymorphic.map((p) => `_${p.attribute}_value`).join(',') },
				headers: { ...headers, Prefer: 'odata.include-annotations="Microsoft.Dynamics.CRM.lookuplogicalname"' },
				itemIndex,
			})) as IDataObject;
			for (const { attribute, candidates } of polymorphic) {
				const target = current[`_${attribute}_value@Microsoft.Dynamics.CRM.lookuplogicalname`];
				const relationship = candidates.find((r) => r.relatedEntity === target);
				if (relationship) navigationProperties.add(relationship.navigationProperty);
			}
		}
	}
	for (const navigationProperty of navigationProperties) {
		await dynamicsApiRequest.call(this, 'DELETE', `${recordPath}/${navigationProperty}/$ref`, undefined, {
			headers,
			itemIndex,
		});
	}
}

/* ----------------------------------------------------- actions & functions */

export function isEnumType(model: CsdlModel, type: string): boolean {
	return model.enums.has(type);
}

export function isEntityType(model: CsdlModel, type: string): boolean {
	return model.entityTypes.has(type);
}

async function toEntityObject(
	this: DynamicsContext,
	declaredType: string,
	value: unknown,
	itemIndex?: number,
): Promise<IDataObject> {
	if (looksLikeJson(value)) value = JSON.parse(value);
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const obj = value as IDataObject;
		// Already an entity payload (has @odata.type or attribute values).
		if (obj['@odata.type'] || !(obj.id || obj.Id)) return obj;
	}
	const reference = parseEntityReference(value);
	if (!reference) {
		throw new NodeOperationError(
			this.getNode(),
			`Could not interpret "${String(value)}" as a record reference for type ${declaredType}`,
			{ itemIndex },
		);
	}
	const entityName = reference.entity ?? (declaredType !== 'crmbaseentity' ? declaredType : undefined);
	if (!entityName) {
		throw new NodeOperationError(
			this.getNode(),
			`A table must be specified for "${reference.id}", e.g. "account:${reference.id}" or "accounts(${reference.id})"`,
			{ itemIndex },
		);
	}
	const entity = await resolveEntity.call(this, entityName, itemIndex);
	return {
		'@odata.type': `${NAMESPACE}.${entity.logicalName}`,
		[entity.primaryIdAttribute]: reference.id,
	};
}

function toPrimitive(type: string, value: unknown): unknown {
	if (value === null || value === undefined) return value;
	switch (type) {
		case 'Edm.Int16':
		case 'Edm.Int32':
		case 'Edm.Int64':
		case 'Edm.Decimal':
		case 'Edm.Double':
		case 'Edm.Single':
			return typeof value === 'string' && value.trim() !== '' && !isNaN(Number(value)) ? Number(value) : value;
		case 'Edm.Boolean':
			if (typeof value === 'string') return value.toLowerCase() === 'true';
			return !!value;
		case 'Edm.Guid':
			return typeof value === 'string' ? normalizeGuid(value) : value;
		default:
			return value;
	}
}

/** Converts a user supplied value into the JSON shape expected for an action parameter. */
export async function convertParameterValue(
	this: DynamicsContext,
	model: CsdlModel,
	parameter: CsdlParameter,
	value: unknown,
	itemIndex?: number,
): Promise<unknown> {
	const { isCollection, itemType } = unwrapCollection(parameter.type);
	if (isCollection) {
		let items: unknown = value;
		if (looksLikeJson(items)) items = JSON.parse(items);
		else if (typeof items === 'string') items = items.split(',').map((x) => x.trim()).filter(Boolean);
		if (!Array.isArray(items)) items = [items];
		const result: unknown[] = [];
		for (const item of items as unknown[]) {
			result.push(
				await convertParameterValue.call(this, model, { ...parameter, type: itemType }, item, itemIndex),
			);
		}
		return result;
	}
	if (isEntityType(model, itemType)) return await toEntityObject.call(this, itemType, value, itemIndex);
	if (isEnumType(model, itemType)) {
		if (Array.isArray(value)) return value.join(',');
		return typeof value === 'number' ? value : String(value);
	}
	if (model.complexTypes.has(itemType)) return looksLikeJson(value) ? JSON.parse(value) : value;
	return toPrimitive(itemType, value);
}

/** Formats a value as an OData URL literal for function parameter aliases. */
export async function formatFunctionLiteral(
	this: DynamicsContext,
	model: CsdlModel,
	parameter: CsdlParameter,
	value: unknown,
	itemIndex?: number,
): Promise<string> {
	const { isCollection, itemType } = unwrapCollection(parameter.type);
	if (isCollection || model.complexTypes.has(itemType)) {
		const converted = await convertParameterValue.call(this, model, parameter, value, itemIndex);
		return JSON.stringify(converted);
	}
	if (isEntityType(model, itemType)) {
		if (looksLikeJson(value)) value = JSON.parse(value);
		const reference = parseEntityReference(value);
		if (!reference) return JSON.stringify(value);
		const entityName = reference.entity ?? (itemType !== 'crmbaseentity' ? itemType : undefined);
		if (!entityName) {
			throw new NodeOperationError(
				this.getNode(),
				`Parameter "${parameter.name}" needs a table, e.g. "account:${reference.id}" or "accounts(${reference.id})"`,
				{ itemIndex },
			);
		}
		const entity = await resolveEntity.call(this, entityName, itemIndex);
		return JSON.stringify({ '@odata.id': `${entity.entitySetName}(${reference.id})` });
	}
	if (isEnumType(model, itemType)) {
		const text = Array.isArray(value) ? value.join(',') : String(value);
		return `${NAMESPACE}.${itemType}${quoteODataString(text)}`;
	}
	switch (itemType) {
		case 'Edm.String':
			return quoteODataString(String(value));
		case 'Edm.Guid':
			return normalizeGuid(String(value));
		case 'Edm.Boolean':
			return String(typeof value === 'string' ? value.toLowerCase() === 'true' : !!value);
		case 'Edm.DateTimeOffset':
		case 'Edm.Date':
			return value instanceof Date ? value.toISOString() : String(value);
		default:
			return String(value);
	}
}

function isEmpty(value: unknown): boolean {
	return value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
}

export function operationPath(operation: CsdlOperation, boundPath?: string): string {
	const name = operation.isBound ? `${NAMESPACE}.${operation.name}` : operation.name;
	return boundPath ? `${boundPath}/${name}` : name;
}

export async function buildActionBody(
	this: DynamicsContext,
	model: CsdlModel,
	operation: CsdlOperation,
	values: IDataObject,
	itemIndex?: number,
): Promise<IDataObject> {
	const body: IDataObject = {};
	const known = new Map(operation.parameters.map((p) => [p.name, p]));
	for (const [name, value] of Object.entries(values)) {
		const parameter = known.get(name);
		if (!parameter) {
			body[name] = value as IDataObject;
			continue;
		}
		if (isEmpty(value)) continue;
		body[name] = (await convertParameterValue.call(this, model, parameter, value, itemIndex)) as IDataObject;
	}
	for (const parameter of operation.parameters) {
		if (!parameter.nullable && !parameter.optional && isEmpty(body[parameter.name])) {
			throw new NodeOperationError(
				this.getNode(),
				`Parameter "${parameter.name}" is required for ${operation.name}`,
				{ itemIndex },
			);
		}
	}
	return body;
}

/** Builds "Name(A=@p1,B=@p2)" plus alias query parameters for a function call. */
export async function buildFunctionCall(
	this: DynamicsContext,
	model: CsdlModel,
	operation: CsdlOperation,
	values: IDataObject,
	boundPath?: string,
	itemIndex?: number,
): Promise<{ path: string; qs: IDataObject }> {
	const assignments: string[] = [];
	const qs: IDataObject = {};
	const known = new Map(operation.parameters.map((p) => [p.name, p]));
	let index = 0;
	for (const [name, value] of Object.entries(values)) {
		if (isEmpty(value)) continue;
		const parameter = known.get(name) ?? { name, type: 'Edm.String', nullable: true, optional: true };
		index++;
		assignments.push(`${name}=@p${index}`);
		qs[`@p${index}`] = await formatFunctionLiteral.call(this, model, parameter, value, itemIndex);
	}
	for (const parameter of operation.parameters) {
		if (!parameter.nullable && !parameter.optional && isEmpty(values[parameter.name])) {
			throw new NodeOperationError(
				this.getNode(),
				`Parameter "${parameter.name}" is required for ${operation.name}`,
				{ itemIndex },
			);
		}
	}
	return { path: `${operationPath(operation, boundPath)}(${assignments.join(',')})`, qs };
}

/* ------------------------------------------------------------------ batch */

export interface BatchRequest {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: unknown;
	contentId?: string;
}

export interface BatchResponse {
	contentId?: string;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body?: unknown;
}

export function buildBatchBody(
	requests: BatchRequest[],
	baseUrl: string,
	useChangeset: boolean,
	boundary: string,
): { body: string; order: number[]; contentIds: Array<string | undefined> } {
	const CRLF = '\r\n';
	const lines: string[] = [];
	const apiPath = new URL(baseUrl).pathname.replace(/\/+$/, '');

	const resolve = (url: string) => {
		if (/^https?:\/\//i.test(url) || url.startsWith('$')) return url;
		if (url.startsWith(apiPath + '/')) return url;
		return `${apiPath}/${url.replace(/^\/+/, '')}`;
	};

	const renderRequest = (request: BatchRequest, contentId?: string) => {
		const part: string[] = ['Content-Type: application/http', 'Content-Transfer-Encoding: binary'];
		if (contentId) part.push(`Content-ID: ${contentId}`);
		part.push('');
		part.push(`${request.method.toUpperCase()} ${resolve(request.url)} HTTP/1.1`);
		const headers: Record<string, string> = { ...request.headers };
		const hasBody = request.body !== undefined && request.body !== null && request.body !== '';
		if (hasBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
			headers['Content-Type'] = 'application/json; type=entry';
		}
		if (!Object.keys(headers).some((h) => h.toLowerCase() === 'accept')) headers.Accept = 'application/json';
		for (const [name, value] of Object.entries(headers)) part.push(`${name}: ${value}`);
		part.push('');
		if (hasBody) part.push(typeof request.body === 'string' ? request.body : JSON.stringify(request.body));
		return part.join(CRLF);
	};

	// GET requests are not allowed inside a change set, so they follow it in the batch.
	const indexed = requests.map((request, index) => ({ request, index }));
	const isRead = (r: BatchRequest) => r.method.toUpperCase() === 'GET';
	const writes = useChangeset ? indexed.filter(({ request }) => !isRead(request)) : [];
	const reads = useChangeset ? indexed.filter(({ request }) => isRead(request)) : indexed;
	const contentIds: Array<string | undefined> = requests.map(() => undefined);

	if (writes.length) {
		const changeset = `changeset_${boundary}`;
		lines.push(`--batch_${boundary}`);
		lines.push(`Content-Type: multipart/mixed; boundary=${changeset}`);
		lines.push('');
		writes.forEach(({ request, index }, position) => {
			const contentId = request.contentId ?? String(position + 1);
			contentIds[index] = contentId;
			lines.push(`--${changeset}`);
			lines.push(renderRequest(request, contentId));
		});
		lines.push(`--${changeset}--`);
	}
	for (const { request } of reads) {
		lines.push(`--batch_${boundary}`);
		lines.push(renderRequest(request));
	}
	lines.push(`--batch_${boundary}--`);
	lines.push('');
	return { body: lines.join(CRLF), order: [...writes, ...reads].map(({ index }) => index), contentIds };
}

function splitMultipart(body: string, boundary: string): string[] {
	const delimiter = `--${boundary}`;
	return body
		.split(delimiter)
		.slice(1)
		.filter((part) => !part.startsWith('--'))
		.map((part) => part.replace(/^\r?\n/, ''));
}

function parseHeaderBlock(block: string): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const line of block.split(/\r?\n/)) {
		const index = line.indexOf(':');
		if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
	}
	return headers;
}

function boundaryOf(contentType: string): string | undefined {
	return /boundary=("?)([^";]+)\1/i.exec(contentType)?.[2];
}

export function parseBatchResponse(body: string, contentType: string): BatchResponse[] {
	const boundary = boundaryOf(contentType);
	if (!boundary) throw new Error('Batch response has no multipart boundary');
	const responses: BatchResponse[] = [];

	for (const part of splitMultipart(body, boundary)) {
		const [partHeaderBlock, ...rest] = part.split(/\r?\n\r?\n/);
		const partHeaders = parseHeaderBlock(partHeaderBlock);
		const partContentType = partHeaders['content-type'] ?? '';
		if (partContentType.startsWith('multipart/mixed')) {
			responses.push(...parseBatchResponse(rest.join('\r\n\r\n'), partContentType));
			continue;
		}
		const httpPart = rest.join('\r\n\r\n');
		const [statusAndHeaders, ...bodyParts] = httpPart.split(/\r?\n\r?\n/);
		const [statusLine, ...headerLines] = statusAndHeaders.split(/\r?\n/);
		const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(statusLine.trim());
		const headers = parseHeaderBlock(headerLines.join('\n'));
		const rawBody = bodyParts.join('\r\n\r\n').trim();
		let parsed: unknown = rawBody || undefined;
		if (rawBody && /^[[{]/.test(rawBody)) {
			try {
				parsed = JSON.parse(rawBody);
			} catch {
				parsed = rawBody;
			}
		}
		responses.push({
			contentId: partHeaders['content-id'],
			status: statusMatch ? Number(statusMatch[1]) : 0,
			statusText: statusMatch ? statusMatch[2] : '',
			headers,
			body: parsed,
		});
	}
	return responses;
}

/* --------------------------------------------------------------- fetchxml */

function escapeXmlAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Returns the decoded paging cookie from the fetchxmlpagingcookie annotation. */
export function extractPagingCookie(annotation: unknown): string | undefined {
	if (typeof annotation !== 'string') return undefined;
	const match = /pagingcookie="([^"]*)"/.exec(annotation);
	if (!match) return undefined;
	let cookie = match[1];
	for (let i = 0; i < 2; i++) {
		try {
			cookie = decodeURIComponent(cookie);
		} catch {
			break;
		}
	}
	return cookie;
}

export function setFetchPaging(fetchXml: string, page: number, pageSize: number, cookie?: string): string {
	return fetchXml.replace(/<fetch\b([^>]*)>/i, (_match, attributes: string) => {
		const cleaned = attributes.replace(/\s(page|paging-cookie|count)\s*=\s*("[^"]*"|'[^']*')/gi, '');
		let tag = `<fetch${cleaned} page="${page}" count="${pageSize}"`;
		if (cookie) tag += ` paging-cookie="${escapeXmlAttribute(cookie)}"`;
		return `${tag}>`;
	});
}

export function fetchHasTop(fetchXml: string): boolean {
	const match = /<fetch\b([^>]*)>/i.exec(fetchXml);
	return !!match && /\stop\s*=/.test(match[1]);
}

export function fetchIsAggregate(fetchXml: string): boolean {
	const match = /<fetch\b([^>]*)>/i.exec(fetchXml);
	return !!match && /\saggregate\s*=\s*["']true["']/i.test(match[1]);
}

export function fetchEntityName(fetchXml: string): string | undefined {
	return /<entity\s+[^>]*name\s*=\s*["']([^"']+)["']/i.exec(fetchXml)?.[1];
}

/* ---------------------------------------------------------------- headers */

export function buildCommonHeaders(options: IDataObject, extraAnnotations: string[] = []): Record<string, string> {
	const headers: Record<string, string> = {};
	const prefer: string[] = [];
	let annotations: string[] = [...extraAnnotations];
	if (options.returnFormattedValues || options.annotations === 'formatted') {
		annotations.unshift('OData.Community.Display.V1.FormattedValue');
	}
	if (options.annotations === 'all') annotations = ['*'];
	// Only one include-annotations preference is allowed, so all names go into one value.
	if (annotations.length) prefer.push(`odata.include-annotations="${annotations.join(',')}"`);
	if (options.impersonateUserId) headers.MSCRMCallerID = normalizeGuid(String(options.impersonateUserId));
	if (options.duplicateDetection) headers['MSCRM.SuppressDuplicateDetection'] = 'false';
	if (options.bypassCustomPluginExecution) headers['MSCRM.BypassCustomPluginExecution'] = 'true';
	if (options.solutionUniqueName) headers['MSCRM.SolutionUniqueName'] = String(options.solutionUniqueName);
	if (options.languageCode) headers['Accept-Language'] = String(options.languageCode);
	if (prefer.length) headers.Prefer = prefer.join(',');
	return headers;
}

export function addPrefer(headers: Record<string, string>, value: string): Record<string, string> {
	return { ...headers, Prefer: [headers.Prefer, value].filter(Boolean).join(',') };
}

/** Extracts the GUID from an OData-EntityId header (".../accounts(guid)"). */
export function idFromEntityIdHeader(header: string | string[] | undefined): string | undefined {
	const value = Array.isArray(header) ? header[0] : header;
	if (!value) return undefined;
	const match = /\(([0-9a-fA-F-]{36})\)\s*$/.exec(value);
	return match ? match[1] : undefined;
}

export async function entityByLogicalName(this: DynamicsContext, logicalName: string): Promise<EntityInfo | undefined> {
	const entities = await getEntities.call(this);
	return entities.find((e) => e.logicalName === logicalName);
}
