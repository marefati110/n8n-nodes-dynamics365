import type { IDataObject, IExecuteFunctions, INodeExecutionData, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { dynamicsApiRequest, getConnection, throwApiError } from '../transport';
import type { HttpResponse } from '../transport/httpClient';
import { resolveEntity } from '../helpers/metadata';
import { buildBatchBody, buildCommonHeaders, parseBatchResponse, parseJsonParameter, type BatchRequest } from '../helpers/odata';
import { toPlainValue } from './common';

interface PendingRequest {
	itemIndex: number;
	request: BatchRequest;
}

function readRequests(this: IExecuteFunctions, i: number): BatchRequest[] {
	const mode = this.getNodeParameter('requestsMode', i, 'define') as string;
	let raw: unknown[];
	if (mode === 'json') {
		const parsed = parseJsonParameter.call(this, this.getNodeParameter('requestsJson', i), 'requestsJson', i);
		raw = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
	} else {
		raw = (this.getNodeParameter('requests.request', i, []) as IDataObject[]) ?? [];
	}

	return raw.map((entry, index) => {
		const request = toPlainValue(entry) as IDataObject;
		const method = String(request.method ?? 'GET').toUpperCase();
		const url = String(request.url ?? '').trim();
		if (!url) {
			throw new NodeOperationError(this.getNode(), `Batch request ${index + 1} has no URL`, { itemIndex: i });
		}
		const body = parseJsonParameter.call(this, request.body, `request ${index + 1} body`, i);
		const headers = parseJsonParameter.call(this, request.headers, `request ${index + 1} headers`, i) as
			| Record<string, string>
			| undefined;
		return {
			method,
			url,
			body: body === '' ? undefined : body,
			headers: headers && typeof headers === 'object' ? headers : undefined,
			contentId: request.contentId ? String(request.contentId) : undefined,
		};
	});
}

/** For "return=representation" creates there is no OData-EntityId header; read the key from the body. */
async function primaryIdFromBody(this: IExecuteFunctions, url: string, body: IDataObject): Promise<string | undefined> {
	const entitySet = /^\/?([A-Za-z_]\w*)/.exec(url.replace(/^.*\/api\/data\/v[\d.]+\//, ''))?.[1];
	if (!entitySet) return undefined;
	try {
		const entity = await resolveEntity.call(this, entitySet);
		const id = body[entity.primaryIdAttribute];
		return typeof id === 'string' ? id : undefined;
	} catch {
		return undefined;
	}
}

async function sendBatch(
	this: IExecuteFunctions,
	pending: PendingRequest[],
	options: IDataObject,
): Promise<INodeExecutionData[]> {
	const connection = await getConnection.call(this);
	const boundary = `n8n_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
	const useChangeset = options.useChangeset !== false;
	const { body, order, contentIds } = buildBatchBody(
		pending.map((p) => p.request),
		connection.baseUrl,
		useChangeset,
		boundary,
	);

	const headers: Record<string, string> = {
		...buildCommonHeaders(options),
		'Content-Type': `multipart/mixed; boundary=batch_${boundary}`,
	};
	if (options.continueOnError) {
		headers.Prefer = [headers.Prefer, 'odata.continue-on-error'].filter(Boolean).join(',');
	}

	const response = (await dynamicsApiRequest.call(this, 'POST', '$batch', undefined, {
		rawBody: body,
		headers,
		fullResponse: true,
		allowErrorStatus: true,
		timeout: options.timeout ? Number(options.timeout) : 300_000,
		itemIndex: pending[0]?.itemIndex,
	})) as HttpResponse;

	const contentType = String(response.headers['content-type'] ?? '');
	if (!contentType.startsWith('multipart/')) {
		// The batch itself was rejected (malformed request, authentication, ...).
		throwApiError.call(this, response, pending[0]?.itemIndex);
	}
	const responses = parseBatchResponse(response.body.toString('utf8'), contentType);

	// Map each response back to its request: change set parts by Content-ID, the rest in order.
	const byContentId = new Map<string, number>();
	contentIds.forEach((id, index) => id !== undefined && byContentId.set(id, index));
	const sequential = order.filter((index) => contentIds[index] === undefined);
	const answered = new Set<number>();
	let nextSequential = 0;

	const results: Array<{ index: number; data: INodeExecutionData }> = [];
	for (const result of responses) {
		let index = result.contentId !== undefined ? byContentId.get(result.contentId) : undefined;
		if (index === undefined) index = sequential[nextSequential++];
		if (index === undefined) continue;
		answered.add(index);
		const original = pending[index];
		const json: IDataObject = {
			status: result.status,
			statusText: result.statusText,
			...(result.contentId ? { contentId: result.contentId } : {}),
			request: { method: original.request.method, url: original.request.url },
		};
		const entityId = result.headers['odata-entityid'];
		if (entityId) {
			json.entityId = entityId;
			const match = /\(([0-9a-f-]{36})\)\s*$/i.exec(entityId);
			if (match) json.id = match[1];
		}
		if (result.body !== undefined) {
			if (result.body && typeof result.body === 'object') {
				const copy = { ...(result.body as IDataObject) };
				delete copy['@odata.context'];
				json.body = copy;
				if (!json.id && result.status === 201) {
					const id = await primaryIdFromBody.call(this, original.request.url, copy);
					if (id) json.id = id;
				}
			} else {
				json.body = result.body as string;
			}
		}
		if (result.status >= 400) {
			const error = (result.body as IDataObject)?.error as IDataObject | undefined;
			json.error = error?.message ?? result.statusText;
			if (options.failOnError) {
				throw new NodeApiError(this.getNode(), (result.body as JsonObject) ?? {}, {
					message: String(json.error),
					httpCode: String(result.status),
					itemIndex: original.itemIndex,
				});
			}
		}
		results.push({ index, data: { json, pairedItem: { item: original.itemIndex } } });
	}

	// A failed change set only reports the failing request; the others were rolled back.
	// Requests after an error without continue-on-error are not executed at all.
	const changesetFailed = responses.some((r) => r.contentId !== undefined && r.status >= 400);
	pending.forEach((original, index) => {
		if (answered.has(index)) return;
		const rolledBack = changesetFailed && contentIds[index] !== undefined;
		results.push({
			index,
			data: {
				json: {
					status: 0,
					request: { method: original.request.method, url: original.request.url },
					error: rolledBack ? 'Rolled back because another request in the change set failed' : 'Not executed',
				},
				pairedItem: { item: original.itemIndex },
			},
		});
	});

	return results.sort((a, b) => a.index - b.index).map((r) => r.data);
}

export async function executeBatch(this: IExecuteFunctions): Promise<INodeExecutionData[]> {
	const items = this.getInputData();
	const combine = this.getNodeParameter('combineItems', 0, true) as boolean;
	const options = this.getNodeParameter('options', 0, {}) as IDataObject;
	const batchSize = Math.min(Math.max(Number(options.batchSize ?? 1000), 1), 1000);
	const output: INodeExecutionData[] = [];

	const run = async (pending: PendingRequest[]) => {
		for (let start = 0; start < pending.length; start += batchSize) {
			output.push(...(await sendBatch.call(this, pending.slice(start, start + batchSize), options)));
		}
	};

	if (combine) {
		const pending: PendingRequest[] = [];
		for (let i = 0; i < items.length; i++) {
			for (const request of readRequests.call(this, i)) pending.push({ itemIndex: i, request });
		}
		if (pending.length) await run(pending);
		return output;
	}

	for (let i = 0; i < items.length; i++) {
		try {
			const itemOptions = this.getNodeParameter('options', i, {}) as IDataObject;
			const pending = readRequests.call(this, i).map((request) => ({ itemIndex: i, request }));
			for (let start = 0; start < pending.length; start += batchSize) {
				output.push(...(await sendBatch.call(this, pending.slice(start, start + batchSize), itemOptions)));
			}
		} catch (error) {
			if (!this.continueOnFail()) throw error;
			output.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
		}
	}
	return output;
}
