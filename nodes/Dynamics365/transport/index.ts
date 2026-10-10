import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	ILoadOptionsFunctions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { ntlmRequest, NtlmAuthenticationError, type HttpResponse, type NtlmConnectionOptions } from './httpClient';

export type DynamicsContext = IExecuteFunctions | ILoadOptionsFunctions | IPollFunctions | IHookFunctions;

export const CREDENTIAL_NAME = 'dynamics365NtlmApi';

export interface DynamicsConnection {
	/** Web API service root without trailing slash, e.g. http://host/org/api/data/v9.1 */
	baseUrl: string;
	options: NtlmConnectionOptions;
	/** Stable key for metadata caches (does not include the password). */
	cacheKey: string;
}

export interface RequestOptions {
	headers?: Record<string, string>;
	qs?: IDataObject;
	/** Raw body (already serialized). When set, `body` is ignored. */
	rawBody?: Buffer | string;
	/** Return the raw HTTP response instead of parsed JSON. */
	fullResponse?: boolean;
	/** Do not throw on 4xx/5xx (used for $batch, whose errors are inside the multipart body). */
	allowErrorStatus?: boolean;
	timeout?: number;
	itemIndex?: number;
}

export function buildConnection(credentials: ICredentialDataDecryptedObject): DynamicsConnection {
	let url = String(credentials.url ?? '').trim();
	if (!url) throw new Error('Organization URL is not set in the credentials');
	url = url.replace(/\/+$/, '');
	const version = String(credentials.apiVersion || '9.1').trim().replace(/^v/i, '');

	// Accept a full Web API URL as well as the organization URL.
	const apiMatch = /^(.*?)\/api\/data(?:\/v[\d.]+)?(?:\/.*)?$/i.exec(url);
	const orgUrl = apiMatch ? apiMatch[1] : url;
	const baseUrl = `${orgUrl}/api/data/v${version}`;

	const options: NtlmConnectionOptions = {
		username: String(credentials.username ?? ''),
		password: String(credentials.password ?? ''),
		domain: String(credentials.domain ?? ''),
		workstation: String(credentials.workstation ?? ''),
		ignoreSslIssues: !!credentials.ignoreSslIssues,
	};
	return {
		baseUrl,
		options,
		cacheKey: `${baseUrl}|${options.domain}|${options.username}`.toLowerCase(),
	};
}

export async function getConnection(this: DynamicsContext): Promise<DynamicsConnection> {
	const credentials = await this.getCredentials(CREDENTIAL_NAME);
	return buildConnection(credentials);
}

/** Serializes query parameters the way the Web API expects ($-prefixed names kept literal). */
export function buildQueryString(qs: IDataObject | undefined): string {
	if (!qs) return '';
	const parts: string[] = [];
	for (const [key, value] of Object.entries(qs)) {
		if (value === undefined || value === null || value === '') continue;
		const encodedKey = key.startsWith('$') || key.startsWith('@') ? key : encodeURIComponent(key);
		parts.push(`${encodedKey}=${encodeURIComponent(String(value))}`);
	}
	return parts.length ? `?${parts.join('&')}` : '';
}

export function resolveUrl(baseUrl: string, resource: string): string {
	if (/^https?:\/\//i.test(resource)) return resource;
	return `${baseUrl}/${resource.replace(/^\/+/, '')}`;
}

export function parseBody(response: HttpResponse): unknown {
	if (!response.body.length) return undefined;
	const contentType = String(response.headers['content-type'] ?? '');
	const text = response.body.toString('utf8');
	if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
		try {
			return JSON.parse(text.replace(/^﻿/, ''));
		} catch {
			return text;
		}
	}
	return text;
}

function extractErrorMessage(body: unknown): { message?: string; code?: string } {
	if (body && typeof body === 'object') {
		const error = (body as IDataObject).error as IDataObject | undefined;
		if (error) {
			const inner = error.innererror as IDataObject | undefined;
			return {
				message: String(error.message ?? inner?.message ?? ''),
				code: error.code ? String(error.code) : undefined,
			};
		}
		if ((body as IDataObject).Message) return { message: String((body as IDataObject).Message) };
	}
	if (typeof body === 'string' && body.trim()) {
		const stripped = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
		return { message: stripped.slice(0, 500) };
	}
	return {};
}

export function throwApiError(
	this: DynamicsContext,
	response: HttpResponse,
	itemIndex?: number,
): never {
	const body = parseBody(response);
	const { message, code } = extractErrorMessage(body);
	const errorBody: JsonObject = {
		statusCode: response.statusCode,
		message: message ?? `HTTP ${response.statusCode}`,
		...(code ? { code } : {}),
		...(body && typeof body === 'object' ? { body: body as JsonObject } : {}),
	};
	throw new NodeApiError(this.getNode(), errorBody, {
		message: message || `Request failed with status code ${response.statusCode}`,
		description: code ? `Dynamics error code: ${code}` : undefined,
		httpCode: String(response.statusCode),
		itemIndex,
	});
}

/**
 * Sends a request to the Dynamics Web API using NTLM authentication.
 * Returns parsed JSON (or undefined for empty responses) unless `fullResponse` is set.
 */
export async function dynamicsApiRequest(
	this: DynamicsContext,
	method: string,
	resource: string,
	body?: unknown,
	options: RequestOptions = {},
): Promise<any> {
	const connection = await getConnection.call(this);
	return await dynamicsApiRequestWithConnection.call(this, connection, method, resource, body, options);
}

export async function dynamicsApiRequestWithConnection(
	this: DynamicsContext,
	connection: DynamicsConnection,
	method: string,
	resource: string,
	body?: unknown,
	options: RequestOptions = {},
): Promise<any> {
	const url = resolveUrl(connection.baseUrl, resource) + buildQueryString(options.qs);
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'OData-MaxVersion': '4.0',
		'OData-Version': '4.0',
		...options.headers,
	};

	let payload: Buffer | string | undefined = options.rawBody;
	if (payload === undefined && body !== undefined) {
		payload = JSON.stringify(body);
		headers['Content-Type'] ??= 'application/json; charset=utf-8';
	}

	let response: HttpResponse;
	try {
		response = await ntlmRequest(connection.options, {
			method,
			url,
			headers,
			body: payload,
			timeout: options.timeout,
		});
	} catch (error) {
		if (error instanceof NtlmAuthenticationError) {
			throw new NodeApiError(
				this.getNode(),
				{ message: error.message, statusCode: error.response.statusCode },
				{ message: error.message, httpCode: String(error.response.statusCode), itemIndex: options.itemIndex },
			);
		}
		throw new NodeOperationError(this.getNode(), error as Error, {
			message: `Could not connect to Dynamics 365: ${(error as Error).message}`,
			itemIndex: options.itemIndex,
		});
	}

	if (response.statusCode >= 400 && !options.allowErrorStatus) throwApiError.call(this, response, options.itemIndex);
	if (options.fullResponse) return response;
	return parseBody(response);
}

export interface PaginationOptions extends RequestOptions {
	/** Max records to return; 0 / undefined means all. */
	limit?: number;
	pageSize?: number;
}

/** Follows @odata.nextLink until all records (or `limit` records) are fetched. */
export async function dynamicsApiRequestAllItems(
	this: DynamicsContext,
	resource: string,
	options: PaginationOptions = {},
): Promise<IDataObject[]> {
	const connection = await getConnection.call(this);
	const results: IDataObject[] = [];
	const pageSize = Math.min(Math.max(options.pageSize ?? 5000, 1), 5000);
	const headers = { ...options.headers };
	headers.Prefer = [headers.Prefer, `odata.maxpagesize=${pageSize}`].filter(Boolean).join(',');

	let next: string | undefined = resource;
	let qs: IDataObject | undefined = options.qs;
	while (next) {
		const page = (await dynamicsApiRequestWithConnection.call(this, connection, 'GET', next, undefined, {
			...options,
			headers,
			qs,
		})) as IDataObject;
		const values = (page?.value as IDataObject[]) ?? [];
		results.push(...values);
		if (options.limit && results.length >= options.limit) return results.slice(0, options.limit);
		next = page['@odata.nextLink'] as string | undefined;
		qs = undefined; // nextLink already contains the query
	}
	return results;
}

/** Strips OData envelope noise from a response object. */
export function cleanODataResponse<T>(data: T): T {
	if (data && typeof data === 'object' && !Array.isArray(data)) {
		const copy = { ...(data as IDataObject) };
		delete copy['@odata.context'];
		return copy as T;
	}
	return data;
}

/** Shared in-memory cache for metadata lookups (entity definitions, CSDL, ...). */
const cache = new Map<string, { expires: number; value: Promise<unknown> }>();

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
	const now = Date.now();
	const entry = cache.get(key);
	if (entry && entry.expires > now) return (await entry.value) as T;
	const value = loader();
	cache.set(key, { expires: now + ttlMs, value });
	try {
		return await value;
	} catch (error) {
		cache.delete(key);
		throw error;
	}
}

export function clearCache(prefix?: string) {
	for (const key of cache.keys()) if (!prefix || key.startsWith(prefix)) cache.delete(key);
}
