import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { dynamicsApiRequest, getConnection, parseBody, resolveUrl } from '../transport';
import type { HttpResponse } from '../transport/httpClient';
import { getJsonObject, type OperationResult } from './common';

function toRecord(entries: Array<{ name: string; value: string }> | undefined): Record<string, string> {
	const result: Record<string, string> = {};
	for (const { name, value } of entries ?? []) if (name) result[name] = value;
	return result;
}

export async function customRequest(this: IExecuteFunctions, i: number): Promise<OperationResult> {
	const method = this.getNodeParameter('method', i) as string;
	const path = (this.getNodeParameter('path', i) as string).trim();
	const qs = toRecord(this.getNodeParameter('queryParameters.parameter', i, []) as Array<{ name: string; value: string }>);
	const headers = toRecord(this.getNodeParameter('headers.header', i, []) as Array<{ name: string; value: string }>);
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	const responseFormat = this.getNodeParameter('responseFormat', i, 'auto') as string;
	const timeout = options.timeout ? Number(options.timeout) : undefined;

	let body: unknown;
	let rawBody: Buffer | string | undefined;
	const sendBody = method !== 'GET' && (this.getNodeParameter('sendBody', i, false) as boolean);
	if (sendBody) {
		const contentType = this.getNodeParameter('bodyContentType', i, 'json') as string;
		if (contentType === 'json') {
			body = getJsonObject.call(this, 'jsonBody', i);
		} else if (contentType === 'binary') {
			const property = this.getNodeParameter('binaryPropertyName', i, 'data') as string;
			const binary = this.helpers.assertBinaryData(i, property);
			rawBody = await this.helpers.getBinaryDataBuffer(i, property);
			headers['Content-Type'] ??= binary.mimeType || 'application/octet-stream';
		} else {
			rawBody = this.getNodeParameter('rawBody', i, '') as string;
			headers['Content-Type'] ??= this.getNodeParameter('rawContentType', i, 'text/plain') as string;
		}
	}
	if (responseFormat === 'binary') headers.Accept ??= '*/*';

	if (method === 'GET' && options.followNextLink && responseFormat !== 'binary') {
		const connection = await getConnection.call(this);
		const values: IDataObject[] = [];
		let next: string | undefined = resolveUrl(connection.baseUrl, path);
		let query: IDataObject | undefined = qs;
		while (next) {
			const page = (await dynamicsApiRequest.call(this, 'GET', next, undefined, { headers, qs: query, timeout, itemIndex: i })) as IDataObject;
			values.push(...((page?.value as IDataObject[]) ?? []));
			next = page?.['@odata.nextLink'] as string | undefined;
			query = undefined;
		}
		return options.splitValue === false ? { value: values } : values;
	}

	const response = (await dynamicsApiRequest.call(this, method, path, body, {
		headers,
		qs,
		rawBody,
		fullResponse: true,
		timeout,
		itemIndex: i,
	})) as HttpResponse;

	if (responseFormat === 'binary') {
		const property = this.getNodeParameter('outputBinaryPropertyName', i, 'data') as string;
		const contentType = String(response.headers['content-type'] ?? 'application/octet-stream');
		const fileNameHeader = response.headers['x-ms-file-name'];
		const fileName = (Array.isArray(fileNameHeader) ? fileNameHeader[0] : fileNameHeader) ?? 'file';
		const binary = await this.helpers.prepareBinaryData(response.body, fileName, contentType);
		const item: INodeExecutionData = {
			json: { statusCode: response.statusCode, headers: response.headers as IDataObject },
			binary: { [property]: binary },
			pairedItem: { item: i },
		};
		return [item];
	}

	const parsed = parseBody(response);
	if (options.fullResponse) {
		return { statusCode: response.statusCode, headers: response.headers as IDataObject, body: parsed as IDataObject };
	}
	if (parsed && typeof parsed === 'object') {
		const data = parsed as IDataObject;
		if (options.splitValue !== false && Array.isArray(data.value)) return data.value as IDataObject[];
		const copy = { ...data };
		delete copy['@odata.context'];
		return copy;
	}
	if (parsed === undefined) {
		const entityId = response.headers['odata-entityid'];
		return { statusCode: response.statusCode, ...(entityId ? { entityId: String(entityId) } : {}) };
	}
	return { statusCode: response.statusCode, body: parsed as string };
}
