import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import {
	dynamicsApiRequest,
	dynamicsApiRequestAllItems,
	getConnection,
	parseBody,
	throwApiError,
	type DynamicsContext,
} from '../transport';
import type { HttpResponse } from '../transport/httpClient';
import {
	findRelationship,
	getAttributes,
	LOOKUP_TYPES,
	resolveEntity,
	toWebApiPropertyNames,
	type AttributeInfo,
	type EntityInfo,
} from '../helpers/metadata';
import {
	addPrefer,
	buildBatchBody,
	buildCommonHeaders,
	buildKeySegment,
	buildRecordBody,
	clearLookupValues,
	convertAttributeValue,
	extractNullBinds,
	extractPagingCookie,
	fetchEntityName,
	fetchHasTop,
	fetchIsAggregate,
	idFromEntityIdHeader,
	normalizeGuid,
	parseBatchResponse,
	parseEntityReference,
	setFetchPaging,
	type RecordPayload,
} from '../helpers/odata';
import { getFilterFromParameters } from '../helpers/filter';
import { getJsonObject, getMappedValues, getOptions, requestTimeout, wrapBody, type OperationResult } from './common';

const MAX_GET_URL_LENGTH = 2000;

async function getEntity(this: IExecuteFunctions, i: number): Promise<EntityInfo> {
	return await resolveEntity.call(this, this.getNodeParameter('entity', i) as string, i);
}

async function getRecordPath(this: IExecuteFunctions, entity: EntityInfo, i: number): Promise<string> {
	const identifyBy = this.getNodeParameter('identifyBy', i, 'id') as string;
	if (identifyBy === 'alternateKey') {
		const keys = (this.getNodeParameter('alternateKey.keys', i, []) as Array<{ key: string; value: unknown }>).filter(
			(k) => k.key,
		);
		if (!keys.length) {
			throw new NodeOperationError(this.getNode(), 'At least one alternate key column is required', { itemIndex: i });
		}
		return `${entity.entitySetName}${await buildKeySegment.call(this, entity, undefined, keys, i)}`;
	}
	const id = this.getNodeParameter('recordId', i) as string;
	return `${entity.entitySetName}${await buildKeySegment.call(this, entity, id, undefined, i)}`;
}

async function selectQuery(
	this: IExecuteFunctions,
	entity: EntityInfo,
	select: unknown,
): Promise<string | undefined> {
	const names = (Array.isArray(select) ? select : String(select ?? '').split(','))
		.map((name) => String(name).trim())
		.filter(Boolean);
	if (!names.length) return undefined;
	return (await toWebApiPropertyNames.call(this, entity.logicalName, names)).join(',');
}

async function getFilter(this: IExecuteFunctions, entityLogicalName: string, i: number): Promise<string | undefined> {
	return await getFilterFromParameters.call(
		this,
		(name, fallback) => this.getNodeParameter(name, i, fallback),
		entityLogicalName,
		i,
	);
}

async function getWritePayload(
	this: IExecuteFunctions,
	entity: EntityInfo,
	mode: 'create' | 'update',
	i: number,
): Promise<RecordPayload> {
	const dataMode = this.getNodeParameter('dataMode', i, 'mapper') as string;
	if (dataMode === 'json') {
		const { body, navigationProperties } = extractNullBinds(getJsonObject.call(this, 'jsonBody', i));
		return { body, clearLookups: [], clearNavigationProperties: mode === 'update' ? navigationProperties : [] };
	}
	const values = getMappedValues.call(this, 'columns', i);
	return await buildRecordBody.call(this, entity, values, mode, i);
}

function hasLookupsToClear(payload: RecordPayload): boolean {
	return payload.clearLookups.length > 0 || payload.clearNavigationProperties.length > 0;
}

function recordIdFromResponse(entity: EntityInfo, response: HttpResponse): string | undefined {
	const fromHeader = idFromEntityIdHeader(response.headers['odata-entityid'] ?? response.headers.location);
	if (fromHeader) return fromHeader;
	const body = parseBody(response) as IDataObject | undefined;
	return body?.[entity.primaryIdAttribute] as string | undefined;
}

async function writeRecord(
	this: IExecuteFunctions,
	i: number,
	method: 'POST' | 'PATCH',
	path: string,
	entity: EntityInfo,
	body: IDataObject,
	extraHeaders: Record<string, string>,
): Promise<{ result: IDataObject; statusCode: number }> {
	const options = getOptions.call(this, i);
	const returnRecord = options.returnRecord !== false;
	let headers = { ...buildCommonHeaders(options), ...extraHeaders };
	const qs: IDataObject = {};
	if (returnRecord) {
		headers = addPrefer(headers, 'return=representation');
		qs.$select = await selectQuery.call(this, entity, options.select);
	}
	const response = (await dynamicsApiRequest.call(this, method, path, body, {
		headers,
		qs,
		fullResponse: true,
		timeout: requestTimeout(options),
		itemIndex: i,
	})) as HttpResponse;

	const parsed = parseBody(response);
	if (parsed && typeof parsed === 'object') return { result: wrapBody(parsed), statusCode: response.statusCode };
	const id = recordIdFromResponse(entity, response);
	return {
		result: { id, ...(id ? { [entity.primaryIdAttribute]: id } : {}) },
		statusCode: response.statusCode,
	};
}

async function create(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const { body } = await getWritePayload.call(this, entity, 'create', i);
	return (await writeRecord.call(this, i, 'POST', entity.entitySetName, entity, body, {})).result;
}

async function update(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const payload = await getWritePayload.call(this, entity, 'update', i);
	if (hasLookupsToClear(payload)) {
		// Clear first so a returned representation already reflects the change.
		await clearLookupValues.call(this, entity, path, payload, buildCommonHeaders(getOptions.call(this, i)), i);
	}
	const { result } = await writeRecord.call(this, i, 'PATCH', path, entity, payload.body, { 'If-Match': '*' });
	return result.id === undefined && !result[entity.primaryIdAttribute] ? { ...result, ...idFromPath(path, entity) } : result;
}

async function upsert(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const behavior = this.getNodeParameter('upsertBehavior', i, 'upsert') as string;
	const headers: Record<string, string> = {};
	if (behavior === 'createOnly') headers['If-None-Match'] = '*';
	if (behavior === 'updateOnly') headers['If-Match'] = '*';
	const payload = await getWritePayload.call(this, entity, 'update', i);
	let { result, statusCode } = await writeRecord.call(this, i, 'PATCH', path, entity, payload.body, headers);
	const created = statusCode === 201 || (statusCode === 204 && behavior === 'createOnly');
	if (hasLookupsToClear(payload) && !created) {
		await clearLookupValues.call(this, entity, path, payload, buildCommonHeaders(getOptions.call(this, i)), i);
		if (getOptions.call(this, i).returnRecord !== false) {
			({ result, statusCode } = await writeRecord.call(this, i, 'PATCH', path, entity, {}, { 'If-Match': '*' }));
		}
	}
	return result.id === undefined && !result[entity.primaryIdAttribute] ? { ...result, ...idFromPath(path, entity) } : result;
}

function idFromPath(path: string, entity: EntityInfo): IDataObject {
	const match = /\(([0-9a-f-]{36})\)$/i.exec(path);
	return match ? { id: match[1], [entity.primaryIdAttribute]: match[1] } : {};
}

async function remove(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const options = getOptions.call(this, i);
	await dynamicsApiRequest.call(this, 'DELETE', path, undefined, {
		headers: buildCommonHeaders(options),
		timeout: requestTimeout(options),
		itemIndex: i,
	});
	return { deleted: true, ...idFromPath(path, entity) };
}

async function get(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const options = getOptions.call(this, i);
	const response = await dynamicsApiRequest.call(this, 'GET', path, undefined, {
		headers: buildCommonHeaders(options),
		qs: {
			$select: await selectQuery.call(this, entity, options.select),
			$expand: options.expand,
		},
		timeout: requestTimeout(options),
		itemIndex: i,
	});
	return wrapBody(response);
}

async function getMany(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const options = getOptions.call(this, i);
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? 0 : (this.getNodeParameter('limit', i, 50) as number);
	const qs: IDataObject = {
		$select: await selectQuery.call(this, entity, options.select),
		$filter: await getFilter.call(this, entity.logicalName, i),
		$orderby: options.orderBy,
		$expand: options.expand,
		$apply: options.apply,
	};
	if (limit) qs.$top = limit;
	return await dynamicsApiRequestAllItems.call(this, entity.entitySetName, {
		qs,
		headers: buildCommonHeaders(options),
		limit,
		pageSize: Math.min(Number(options.pageSize ?? 5000), limit || 5000),
		timeout: requestTimeout(options),
		itemIndex: i,
	});
}

/** Sends a GET through $batch: used when a URL (e.g. long FetchXML) exceeds server limits. */
async function getViaBatch(
	this: DynamicsContext,
	path: string,
	headers: Record<string, string>,
	timeout: number | undefined,
	itemIndex: number,
): Promise<IDataObject> {
	const connection = await getConnection.call(this);
	const boundary = `n8n${Date.now()}`;
	const { body } = buildBatchBody([{ method: 'GET', url: path, headers }], connection.baseUrl, false, boundary);
	const response = (await dynamicsApiRequest.call(this, 'POST', '$batch', undefined, {
		rawBody: body,
		headers: { 'Content-Type': `multipart/mixed; boundary=batch_${boundary}` },
		fullResponse: true,
		allowErrorStatus: true,
		timeout,
		itemIndex,
	})) as HttpResponse;
	const contentType = String(response.headers['content-type'] ?? '');
	if (!contentType.startsWith('multipart/')) throwApiError.call(this, response, itemIndex);
	const [result] = parseBatchResponse(response.body.toString('utf8'), contentType);
	if (!result || result.status >= 400) {
		const error = (result?.body as IDataObject)?.error as IDataObject | undefined;
		throw new NodeOperationError(this.getNode(), String(error?.message ?? `Request failed with status ${result?.status}`), {
			itemIndex,
		});
	}
	return result.body as IDataObject;
}

async function getWithLongUrlFallback(
	this: IExecuteFunctions,
	path: string,
	headers: Record<string, string>,
	timeout: number | undefined,
	i: number,
): Promise<IDataObject> {
	if (path.length > MAX_GET_URL_LENGTH) return await getViaBatch.call(this, path, headers, timeout, i);
	return (await dynamicsApiRequest.call(this, 'GET', path, undefined, { headers, timeout, itemIndex: i })) as IDataObject;
}

async function fetchXml(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const fetch = (this.getNodeParameter('fetchXml', i) as string).trim();
	const entityName = fetchEntityName(fetch);
	if (!entityName) {
		throw new NodeOperationError(this.getNode(), 'FetchXML must contain an <entity name="..."> element', { itemIndex: i });
	}
	const entity = await resolveEntity.call(this, entityName, i);
	const options = getOptions.call(this, i);
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? 0 : (this.getNodeParameter('limit', i, 50) as number);
	const timeout = requestTimeout(options);

	const headers = buildCommonHeaders(options, [
		'Microsoft.Dynamics.CRM.fetchxmlpagingcookie',
		'Microsoft.Dynamics.CRM.morerecords',
	]);

	const request = (xml: string) =>
		getWithLongUrlFallback.call(this, `${entity.entitySetName}?fetchXml=${encodeURIComponent(xml)}`, headers, timeout, i);

	if (fetchHasTop(fetch) || fetchIsAggregate(fetch)) {
		const page = await request(fetch);
		const values = (page.value as IDataObject[]) ?? [];
		return limit ? values.slice(0, limit) : values;
	}

	const results: IDataObject[] = [];
	const pageSize = Math.min(Number(options.pageSize ?? 5000), limit || 5000, 5000);
	let pageNumber = 1;
	let cookie: string | undefined;
	for (;;) {
		const page = await request(setFetchPaging(fetch, pageNumber, pageSize, cookie));
		results.push(...((page.value as IDataObject[]) ?? []));
		if (limit && results.length >= limit) return results.slice(0, limit);
		if (!page['@Microsoft.Dynamics.CRM.morerecords']) break;
		cookie = extractPagingCookie(page['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie']);
		pageNumber++;
	}
	return results;
}

async function executeView(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const options = getOptions.call(this, i);
	const viewType = this.getNodeParameter('viewType', i, 'savedquery') as string;
	const viewId = normalizeGuid(this.getNodeParameter('viewId', i) as string);
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? 0 : (this.getNodeParameter('limit', i, 50) as number);
	return await dynamicsApiRequestAllItems.call(this, entity.entitySetName, {
		qs: { [viewType === 'userquery' ? 'userQuery' : 'savedQuery']: viewId },
		headers: buildCommonHeaders(options),
		limit,
		pageSize: Math.min(Number(options.pageSize ?? 5000), limit || 5000, 5000),
		timeout: requestTimeout(options),
		itemIndex: i,
	});
}

async function count(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const options = getOptions.call(this, i);
	const headers = buildCommonHeaders(options);
	const timeout = requestTimeout(options);
	const filter = (await getFilter.call(this, entity.logicalName, i)) ?? '';

	if (!filter) {
		// FetchXML aggregate is exact and fast, but limited to 50,000 records by the server.
		const fetch = `<fetch aggregate="true"><entity name="${entity.logicalName}"><attribute name="${entity.primaryIdAttribute}" aggregate="count" alias="count" /></entity></fetch>`;
		try {
			const response = (await dynamicsApiRequest.call(this, 'GET', entity.entitySetName, undefined, {
				qs: { fetchXml: fetch },
				headers,
				timeout,
				itemIndex: i,
			})) as IDataObject;
			const value = ((response.value as IDataObject[]) ?? [])[0]?.count;
			if (value !== undefined) return { entity: entity.logicalName, count: Number(value) };
		} catch (error) {
			if (!/AggregateQueryRecordLimit|0x8004e023/i.test(String((error as Error).message) + JSON.stringify(error))) throw error;
		}
	}

	// Page through the primary key only and count.
	const records = await dynamicsApiRequestAllItems.call(this, entity.entitySetName, {
		qs: { $select: entity.primaryIdAttribute, $filter: filter || undefined },
		headers,
		timeout,
		itemIndex: i,
	});
	return { entity: entity.logicalName, count: records.length };
}

async function relatedTarget(
	this: IExecuteFunctions,
	relatedEntity: string,
	value: string,
	i: number,
): Promise<{ entity: EntityInfo; id: string }> {
	const reference = parseEntityReference(value);
	if (!reference) {
		throw new NodeOperationError(this.getNode(), `"${value}" is not a valid related record ID`, { itemIndex: i });
	}
	const entity = await resolveEntity.call(this, reference.entity ?? relatedEntity, i);
	return { entity, id: reference.id };
}

async function getRelated(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const relationship = await findRelationship.call(
		this,
		entity.logicalName,
		this.getNodeParameter('relationship', i) as string,
		i,
	);
	const options = getOptions.call(this, i);
	const headers = buildCommonHeaders(options);
	const qs: IDataObject = {
		$select: options.select,
		$filter: await getFilter.call(this, relationship.relatedEntity, i),
		$orderby: options.orderBy,
	};
	const relatedPath = `${path}/${relationship.navigationProperty}`;

	if (!relationship.isCollection) {
		delete qs.$filter;
		delete qs.$orderby;
		const response = await dynamicsApiRequest.call(this, 'GET', relatedPath, undefined, {
			headers,
			qs,
			timeout: requestTimeout(options),
			itemIndex: i,
		});
		return response ? wrapBody(response) : [];
	}
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? 0 : (this.getNodeParameter('limit', i, 50) as number);
	if (limit) qs.$top = limit;
	return await dynamicsApiRequestAllItems.call(this, relatedPath, {
		qs,
		headers,
		limit,
		timeout: requestTimeout(options),
		itemIndex: i,
	});
}

async function associate(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const relationship = await findRelationship.call(
		this,
		entity.logicalName,
		this.getNodeParameter('relationship', i) as string,
		i,
	);
	const related = await relatedTarget.call(
		this,
		relationship.relatedEntity,
		this.getNodeParameter('relatedRecordId', i) as string,
		i,
	);
	const options = getOptions.call(this, i);
	const { baseUrl } = await getConnection.call(this);
	await dynamicsApiRequest.call(
		this,
		relationship.isCollection ? 'POST' : 'PUT',
		`${path}/${relationship.navigationProperty}/$ref`,
		{ '@odata.id': `${baseUrl}/${related.entity.entitySetName}(${related.id})` },
		{ headers: buildCommonHeaders(options), timeout: requestTimeout(options), itemIndex: i },
	);
	return {
		associated: true,
		relationship: relationship.navigationProperty,
		...idFromPath(path, entity),
		relatedEntity: related.entity.logicalName,
		relatedId: related.id,
	};
}

async function disassociate(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const relationship = await findRelationship.call(
		this,
		entity.logicalName,
		this.getNodeParameter('relationship', i) as string,
		i,
	);
	const options = getOptions.call(this, i);
	let target = `${path}/${relationship.navigationProperty}/$ref`;
	let relatedId: string | undefined;
	if (relationship.isCollection) {
		const related = await relatedTarget.call(
			this,
			relationship.relatedEntity,
			this.getNodeParameter('relatedRecordId', i) as string,
			i,
		);
		relatedId = related.id;
		target = `${path}/${relationship.navigationProperty}(${related.id})/$ref`;
	}
	await dynamicsApiRequest.call(this, 'DELETE', target, undefined, {
		headers: buildCommonHeaders(options),
		timeout: requestTimeout(options),
		itemIndex: i,
	});
	return {
		disassociated: true,
		relationship: relationship.navigationProperty,
		...idFromPath(path, entity),
		...(relatedId ? { relatedId } : {}),
	};
}

async function patchRecord(this: IExecuteFunctions, i: number, path: string, body: IDataObject) {
	const options = getOptions.call(this, i);
	await dynamicsApiRequest.call(this, 'PATCH', path, body, {
		headers: { ...buildCommonHeaders(options), 'If-Match': '*' },
		timeout: requestTimeout(options),
		itemIndex: i,
	});
}

async function assign(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const ownerType = this.getNodeParameter('ownerType', i) as string;
	const ownerId = normalizeGuid(this.getNodeParameter('ownerId', i) as string);
	const owner = await resolveEntity.call(this, ownerType, i);
	await patchRecord.call(this, i, path, { 'ownerid@odata.bind': `/${owner.entitySetName}(${ownerId})` });
	return { assigned: true, ...idFromPath(path, entity), ownerType, ownerId };
}

async function setState(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const stateCode = Number(this.getNodeParameter('stateCode', i));
	const statusCode = Number(this.getNodeParameter('statusCode', i, -1));
	const body: IDataObject = { statecode: stateCode };
	if (statusCode !== -1 && !isNaN(statusCode)) body.statuscode = statusCode;
	await patchRecord.call(this, i, path, body);
	return { ...idFromPath(path, entity), ...body };
}

async function getAttribute(this: IExecuteFunctions, entity: EntityInfo, name: string, i: number): Promise<AttributeInfo> {
	const attributes = await getAttributes.call(this, entity.logicalName);
	const attribute = attributes.find((a) => a.logicalName === name);
	if (!attribute) {
		throw new NodeOperationError(this.getNode(), `Column "${name}" was not found on table "${entity.logicalName}"`, {
			itemIndex: i,
		});
	}
	return attribute;
}

async function getFieldValue(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const field = this.getNodeParameter('field', i) as string;
	const [property] = await toWebApiPropertyNames.call(this, entity.logicalName, [field]);
	const options = getOptions.call(this, i);
	const response = (await dynamicsApiRequest.call(this, 'GET', `${path}/${property}`, undefined, {
		headers: buildCommonHeaders(options),
		timeout: requestTimeout(options),
		itemIndex: i,
	})) as IDataObject | undefined;
	return { ...idFromPath(path, entity), [field]: response?.value ?? null };
}

async function setFieldValue(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const field = this.getNodeParameter('field', i) as string;
	const attribute = await getAttribute.call(this, entity, field, i);
	const rawValue = this.getNodeParameter('value', i, '');
	const options = getOptions.call(this, i);

	let value: unknown = rawValue;
	if (LOOKUP_TYPES.has(attribute.attributeType)) {
		const payload = await buildRecordBody.call(this, entity, { [field]: rawValue === '' ? null : rawValue }, 'update', i);
		if (hasLookupsToClear(payload)) {
			await clearLookupValues.call(this, entity, path, payload, buildCommonHeaders(options), i);
		} else {
			await patchRecord.call(this, i, path, payload.body);
		}
	} else {
		value = rawValue === '' ? null : convertAttributeValue(attribute, rawValue);
		await dynamicsApiRequest.call(
			this,
			'PUT',
			`${path}/${field}`,
			{ value },
			{ headers: buildCommonHeaders(options), timeout: requestTimeout(options), itemIndex: i },
		);
	}
	return { ...idFromPath(path, entity), [field]: value as string };
}

async function clearFieldValue(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const field = this.getNodeParameter('field', i) as string;
	const attribute = await getAttribute.call(this, entity, field, i);
	const options = getOptions.call(this, i);
	const requestOptions = { headers: buildCommonHeaders(options), timeout: requestTimeout(options), itemIndex: i };

	if (LOOKUP_TYPES.has(attribute.attributeType)) {
		await clearLookupValues.call(
			this,
			entity,
			path,
			{ clearLookups: [field], clearNavigationProperties: [] },
			requestOptions.headers,
			i,
		);
	} else {
		await dynamicsApiRequest.call(this, 'DELETE', `${path}/${field}`, undefined, requestOptions);
	}
	return { ...idFromPath(path, entity), [field]: null };
}

function sniffMimeType(buffer: Buffer): { mimeType: string; extension: string } {
	if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
		return { mimeType: 'image/png', extension: 'png' };
	}
	if (buffer[0] === 0xff && buffer[1] === 0xd8) return { mimeType: 'image/jpeg', extension: 'jpg' };
	if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return { mimeType: 'image/gif', extension: 'gif' };
	if (buffer.subarray(0, 4).toString('ascii') === '%PDF') return { mimeType: 'application/pdf', extension: 'pdf' };
	return { mimeType: 'application/octet-stream', extension: 'bin' };
}

async function downloadFile(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const field = this.getNodeParameter('field', i) as string;
	const attribute = await getAttribute.call(this, entity, field, i);
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
	const fullSize = this.getNodeParameter('fullSize', i, true) as boolean;
	const options = getOptions.call(this, i);

	const download = async (qs?: IDataObject) =>
		(await dynamicsApiRequest.call(this, 'GET', `${path}/${field}/$value`, undefined, {
			headers: { ...buildCommonHeaders(options), Accept: '*/*' },
			qs,
			fullResponse: true,
			timeout: requestTimeout(options),
			itemIndex: i,
		})) as HttpResponse;

	const wantsFullImage = attribute.typeName === 'ImageType' && fullSize;
	let response = await download(wantsFullImage ? { size: 'full' } : undefined);
	// Servers without full-size image storage (e.g. on-premises) answer 204 for size=full.
	if (wantsFullImage && !response.body.length) response = await download();
	if (!response.body.length) {
		throw new NodeOperationError(this.getNode(), `Column "${field}" has no file or image for this record`, {
			itemIndex: i,
		});
	}

	let buffer = response.body;
	const contentType = String(response.headers['content-type'] ?? '');
	// Some versions return image columns as a base64 JSON string.
	if (contentType.includes('json') || contentType.startsWith('text/')) {
		const parsed = parseBody(response);
		const text = typeof parsed === 'object' ? String((parsed as IDataObject)?.value ?? '') : String(parsed ?? '');
		buffer = Buffer.from(text, 'base64');
	}
	const sniffed = sniffMimeType(buffer);
	const headerName = response.headers['x-ms-file-name'];
	const fileName = (Array.isArray(headerName) ? headerName[0] : headerName) ?? `${entity.logicalName}_${field}.${sniffed.extension}`;
	const mimeType = contentType && !contentType.includes('octet-stream') && !contentType.includes('json') ? contentType : sniffed.mimeType;

	const binary = await this.helpers.prepareBinaryData(buffer, fileName, mimeType);
	const item: INodeExecutionData = {
		json: { ...idFromPath(path, entity), field, fileName, size: buffer.length },
		binary: { [binaryPropertyName]: binary },
		pairedItem: { item: i },
	};
	return [item];
}

async function uploadFile(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const entity = await getEntity.call(this, i);
	const path = await getRecordPath.call(this, entity, i);
	const field = this.getNodeParameter('field', i) as string;
	const attribute = await getAttribute.call(this, entity, field, i);
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
	const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
	const options = getOptions.call(this, i);

	if (attribute.typeName === 'ImageType') {
		await patchRecord.call(this, i, path, { [field]: buffer.toString('base64') });
	} else {
		await dynamicsApiRequest.call(this, 'PATCH', `${path}/${field}`, undefined, {
			rawBody: buffer,
			headers: {
				...buildCommonHeaders(options),
				'Content-Type': 'application/octet-stream',
				'x-ms-file-name': encodeURIComponent(binaryData.fileName ?? `${field}.bin`),
			},
			timeout: requestTimeout(options),
			itemIndex: i,
		});
	}
	return { ...idFromPath(path, entity), field, fileName: binaryData.fileName, size: buffer.length, uploaded: true };
}

export const recordOperations: Record<string, (this: IExecuteFunctions, i: number) => Promise<OperationResult>> = {
	assign,
	associate,
	clearFieldValue,
	count,
	create,
	delete: remove,
	disassociate,
	downloadFile,
	executeView,
	fetchXml,
	get,
	getFieldValue,
	getMany,
	getRelated,
	setFieldValue,
	setState,
	update,
	uploadFile,
	upsert,
};
