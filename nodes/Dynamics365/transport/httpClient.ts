import { createHash } from 'crypto';
import * as http from 'http';
import * as https from 'https';
import type { IncomingHttpHeaders } from 'http';
import {
	createType1Message,
	createType3Message,
	extractChallengeToken,
	parseType2Message,
	supportedSchemes,
	type NtlmIdentity,
} from './ntlm';

export interface HttpRequestOptions {
	method: string;
	url: string;
	headers?: Record<string, string>;
	body?: Buffer | string;
	timeout?: number;
}

export interface HttpResponse {
	statusCode: number;
	headers: IncomingHttpHeaders;
	body: Buffer;
}

export interface NtlmConnectionOptions extends NtlmIdentity {
	ignoreSslIssues?: boolean;
}

const DEFAULT_TIMEOUT = 120_000;
const POOL_SIZE = 4;
const BODYLESS_METHODS = new Set(['GET', 'HEAD', 'DELETE', 'OPTIONS']);

function isRetryableSocketError(error: NodeJS.ErrnoException): boolean {
	return (
		error.code === 'ECONNRESET' ||
		error.code === 'EPIPE' ||
		error.message === 'socket hang up'
	);
}

/**
 * One keep-alive socket that performs the NTLM handshake. NTLM authenticates the TCP
 * connection, so every message of a handshake must travel on the same socket; requests
 * on a connection are serialized for that reason.
 */
class NtlmConnection {
	private readonly agent: http.Agent;
	private authenticated = false;
	private queue: Promise<unknown> = Promise.resolve();
	pending = 0;

	constructor(
		private readonly options: NtlmConnectionOptions,
		secure: boolean,
	) {
		const agentOptions = { keepAlive: true, maxSockets: 1, maxFreeSockets: 1 };
		this.agent = secure
			? new https.Agent({ ...agentOptions, rejectUnauthorized: !options.ignoreSslIssues })
			: new http.Agent(agentOptions);
	}

	request(request: HttpRequestOptions): Promise<HttpResponse> {
		this.pending++;
		const run = this.queue.then(() => this.execute(request));
		this.queue = run.catch(() => undefined);
		return run.finally(() => {
			this.pending--;
		});
	}

	destroy() {
		this.agent.destroy();
	}

	private async execute(request: HttpRequestOptions): Promise<HttpResponse> {
		if (this.authenticated) {
			const response = await this.send(request, true);
			if (response.statusCode !== 401) return response;
			this.authenticated = false;
		}
		return await this.handshake(request);
	}

	private async handshake(request: HttpRequestOptions, scheme: 'NTLM' | 'Negotiate' = 'NTLM'): Promise<HttpResponse> {
		const negotiateRequest: HttpRequestOptions = {
			...request,
			body: undefined,
			headers: { ...request.headers, Authorization: `${scheme} ${createType1Message()}` },
		};
		const challengeResponse = await this.send(negotiateRequest, true);

		if (challengeResponse.statusCode !== 401) {
			// Server did not require authentication on this connection.
			this.authenticated = true;
			if (BODYLESS_METHODS.has(request.method.toUpperCase()) && !request.body) return challengeResponse;
			return await this.send(request, false);
		}

		const wwwAuthenticate = challengeResponse.headers['www-authenticate'];
		const challenge = extractChallengeToken(wwwAuthenticate);
		if (!challenge) {
			const schemes = supportedSchemes(wwwAuthenticate);
			if (scheme === 'NTLM' && schemes.some((s) => s.toLowerCase() === 'negotiate')) {
				return await this.handshake(request, 'Negotiate');
			}
			throw new NtlmAuthenticationError(
				schemes.length
					? `Server did not return an NTLM challenge (offered: ${schemes.join(', ')})`
					: 'Server did not return an NTLM challenge. Check that Windows authentication is enabled.',
				challengeResponse,
			);
		}

		const type2 = parseType2Message(challenge.token);
		const type3 = createType3Message(type2, this.options);
		const response = await this.send(
			{ ...request, headers: { ...request.headers, Authorization: `${challenge.scheme} ${type3}` } },
			false,
		);
		if (response.statusCode === 401) {
			throw new NtlmAuthenticationError(
				'NTLM authentication failed: invalid username, password or domain',
				response,
			);
		}
		this.authenticated = true;
		return response;
	}

	private async send(request: HttpRequestOptions, retryOnReset: boolean): Promise<HttpResponse> {
		try {
			return await this.rawSend(request);
		} catch (error) {
			if (retryOnReset && isRetryableSocketError(error as NodeJS.ErrnoException)) {
				// A kept-alive socket was closed by the server: the new socket is unauthenticated.
				this.authenticated = false;
				return await this.rawSend(request);
			}
			throw error;
		}
	}

	private rawSend(request: HttpRequestOptions): Promise<HttpResponse> {
		return new Promise((resolve, reject) => {
			const url = new URL(request.url);
			const transport = url.protocol === 'https:' ? https : http;
			const body =
				request.body === undefined
					? Buffer.alloc(0)
					: Buffer.isBuffer(request.body)
						? request.body
						: Buffer.from(request.body, 'utf8');
			const headers: Record<string, string | number> = {
				Connection: 'keep-alive',
				...request.headers,
				'Content-Length': body.length,
			};

			const req = transport.request(
				url,
				{ method: request.method.toUpperCase(), headers, agent: this.agent },
				(res) => {
					const chunks: Buffer[] = [];
					res.on('data', (chunk: Buffer) => chunks.push(chunk));
					res.on('error', reject);
					res.on('end', () =>
						resolve({
							statusCode: res.statusCode ?? 0,
							headers: res.headers,
							body: Buffer.concat(chunks),
						}),
					);
				},
			);
			const timeout = request.timeout ?? DEFAULT_TIMEOUT;
			req.setTimeout(timeout, () => {
				req.destroy(Object.assign(new Error(`Request timed out after ${timeout}ms`), { code: 'ETIMEDOUT' }));
			});
			req.on('error', reject);
			req.end(body);
		});
	}
}

export class NtlmAuthenticationError extends Error {
	constructor(
		message: string,
		readonly response: HttpResponse,
	) {
		super(message);
		this.name = 'NtlmAuthenticationError';
	}
}

/**
 * Small pool of authenticated connections per credential/origin so parallel requests do
 * not have to wait for each other or re-authenticate.
 */
class NtlmConnectionPool {
	private readonly connections: NtlmConnection[] = [];
	lastUsed = Date.now();

	constructor(
		private readonly options: NtlmConnectionOptions,
		private readonly secure: boolean,
	) {}

	request(request: HttpRequestOptions): Promise<HttpResponse> {
		this.lastUsed = Date.now();
		let connection = this.connections.find((c) => c.pending === 0);
		if (!connection && this.connections.length < POOL_SIZE) {
			connection = new NtlmConnection(this.options, this.secure);
			this.connections.push(connection);
		}
		connection ??= this.connections.reduce((a, b) => (a.pending <= b.pending ? a : b));
		return connection.request(request);
	}

	destroy() {
		for (const connection of this.connections) connection.destroy();
	}
}

const pools = new Map<string, NtlmConnectionPool>();
const POOL_IDLE_MS = 10 * 60_000;

function poolKey(origin: string, options: NtlmConnectionOptions): string {
	return createHash('sha256')
		.update(
			JSON.stringify([
				origin,
				options.username,
				options.password,
				options.domain ?? '',
				options.workstation ?? '',
				!!options.ignoreSslIssues,
			]),
		)
		.digest('hex');
}

function evictIdlePools() {
	const now = Date.now();
	for (const [key, pool] of pools) {
		if (now - pool.lastUsed > POOL_IDLE_MS) {
			pool.destroy();
			pools.delete(key);
		}
	}
}

export async function ntlmRequest(
	options: NtlmConnectionOptions,
	request: HttpRequestOptions,
): Promise<HttpResponse> {
	evictIdlePools();
	const url = new URL(request.url);
	const key = poolKey(url.origin, options);
	let pool = pools.get(key);
	if (!pool) {
		pool = new NtlmConnectionPool(options, url.protocol === 'https:');
		pools.set(key, pool);
	}
	return await pool.request(request);
}
