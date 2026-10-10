import { createHmac, randomBytes } from 'crypto';

/**
 * Self-contained NTLMv2 implementation (MS-NLMP) so the package has no runtime
 * dependencies. MD4 is implemented in JS because OpenSSL 3 disables it by default.
 */

const NTLMSSP_SIGNATURE = Buffer.from('NTLMSSP\0', 'ascii');

export const NtlmFlags = {
	NEGOTIATE_UNICODE: 0x00000001,
	NEGOTIATE_OEM: 0x00000002,
	REQUEST_TARGET: 0x00000004,
	NEGOTIATE_NTLM: 0x00000200,
	NEGOTIATE_ALWAYS_SIGN: 0x00008000,
	NEGOTIATE_EXTENDED_SESSIONSECURITY: 0x00080000,
	NEGOTIATE_TARGET_INFO: 0x00800000,
	NEGOTIATE_VERSION: 0x02000000,
	NEGOTIATE_128: 0x20000000,
	NEGOTIATE_KEY_EXCH: 0x40000000,
	NEGOTIATE_56: 0x80000000,
} as const;

const TYPE1_FLAGS =
	(NtlmFlags.NEGOTIATE_UNICODE |
		NtlmFlags.NEGOTIATE_OEM |
		NtlmFlags.REQUEST_TARGET |
		NtlmFlags.NEGOTIATE_NTLM |
		NtlmFlags.NEGOTIATE_ALWAYS_SIGN |
		NtlmFlags.NEGOTIATE_EXTENDED_SESSIONSECURITY |
		NtlmFlags.NEGOTIATE_TARGET_INFO |
		NtlmFlags.NEGOTIATE_128 |
		NtlmFlags.NEGOTIATE_56) >>>
	0;

const AV_EOL = 0x0000;
const AV_TIMESTAMP = 0x0007;

export interface NtlmIdentity {
	username: string;
	password: string;
	domain?: string;
	workstation?: string;
}

export interface NtlmChallenge {
	flags: number;
	serverChallenge: Buffer;
	targetName: string;
	targetInfo: Buffer;
}

/* ------------------------------------------------------------------ MD4 */

function rotl(x: number, n: number): number {
	return (x << n) | (x >>> (32 - n));
}

export function md4(input: Buffer): Buffer {
	const length = input.length;
	const blockCount = ((length + 8) >>> 6) + 1;
	const words = new Uint32Array(blockCount * 16);
	for (let i = 0; i < length; i++) words[i >> 2] |= input[i] << ((i % 4) * 8);
	words[length >> 2] |= 0x80 << ((length % 4) * 8);
	const bitLength = length * 8;
	words[blockCount * 16 - 2] = bitLength >>> 0;
	words[blockCount * 16 - 1] = Math.floor(bitLength / 0x100000000);

	let a = 0x67452301;
	let b = 0xefcdab89;
	let c = 0x98badcfe;
	let d = 0x10325476;

	const F = (x: number, y: number, z: number) => (x & y) | (~x & z);
	const G = (x: number, y: number, z: number) => (x & y) | (x & z) | (y & z);
	const H = (x: number, y: number, z: number) => x ^ y ^ z;

	for (let block = 0; block < blockCount; block++) {
		const X = words.subarray(block * 16, block * 16 + 16);
		const [aa, bb, cc, dd] = [a, b, c, d];

		for (const i of [0, 4, 8, 12]) {
			a = rotl(a + F(b, c, d) + X[i], 3);
			d = rotl(d + F(a, b, c) + X[i + 1], 7);
			c = rotl(c + F(d, a, b) + X[i + 2], 11);
			b = rotl(b + F(c, d, a) + X[i + 3], 19);
		}
		for (const i of [0, 1, 2, 3]) {
			a = rotl(a + G(b, c, d) + X[i] + 0x5a827999, 3);
			d = rotl(d + G(a, b, c) + X[i + 4] + 0x5a827999, 5);
			c = rotl(c + G(d, a, b) + X[i + 8] + 0x5a827999, 9);
			b = rotl(b + G(c, d, a) + X[i + 12] + 0x5a827999, 13);
		}
		for (const i of [0, 2, 1, 3]) {
			a = rotl(a + H(b, c, d) + X[i] + 0x6ed9eba1, 3);
			d = rotl(d + H(a, b, c) + X[i + 8] + 0x6ed9eba1, 9);
			c = rotl(c + H(d, a, b) + X[i + 4] + 0x6ed9eba1, 11);
			b = rotl(b + H(c, d, a) + X[i + 12] + 0x6ed9eba1, 15);
		}

		a = (a + aa) | 0;
		b = (b + bb) | 0;
		c = (c + cc) | 0;
		d = (d + dd) | 0;
	}

	const out = Buffer.alloc(16);
	out.writeInt32LE(a, 0);
	out.writeInt32LE(b, 4);
	out.writeInt32LE(c, 8);
	out.writeInt32LE(d, 12);
	return out;
}

/* ------------------------------------------------------------- hashes */

function hmacMd5(key: Buffer, ...data: Buffer[]): Buffer {
	const hmac = createHmac('md5', key);
	for (const chunk of data) hmac.update(chunk);
	return hmac.digest();
}

export function ntHash(password: string): Buffer {
	return md4(Buffer.from(password, 'utf16le'));
}

export function ntlmv2Hash(username: string, password: string, domain: string): Buffer {
	return hmacMd5(ntHash(password), Buffer.from(username.toUpperCase() + domain, 'utf16le'));
}

/**
 * Splits "DOMAIN\user" or "user@domain" when no explicit domain was configured.
 */
export function normalizeIdentity(identity: NtlmIdentity): NtlmIdentity {
	let { username, domain } = identity;
	domain = (domain ?? '').trim();
	if (!domain) {
		if (username.includes('\\')) {
			[domain, username] = username.split('\\', 2);
		} else if (username.includes('@')) {
			const index = username.lastIndexOf('@');
			domain = username.slice(index + 1);
			username = username.slice(0, index);
		}
	}
	return { ...identity, username, domain };
}

/* ----------------------------------------------------------- messages */

export function createType1Message(): string {
	const buffer = Buffer.alloc(32);
	NTLMSSP_SIGNATURE.copy(buffer, 0);
	buffer.writeUInt32LE(1, 8);
	buffer.writeUInt32LE(TYPE1_FLAGS, 12);
	// Empty domain and workstation security buffers (offset 32, length 0).
	buffer.writeUInt32LE(0, 16);
	buffer.writeUInt32LE(32, 20);
	buffer.writeUInt32LE(0, 24);
	buffer.writeUInt32LE(32, 28);
	return buffer.toString('base64');
}

function readSecurityBuffer(message: Buffer, offset: number): Buffer {
	const length = message.readUInt16LE(offset);
	const start = message.readUInt32LE(offset + 4);
	if (length === 0 || start + length > message.length) return Buffer.alloc(0);
	return message.subarray(start, start + length);
}

export function parseType2Message(base64: string): NtlmChallenge {
	const message = Buffer.from(base64, 'base64');
	if (message.length < 32 || !message.subarray(0, 8).equals(NTLMSSP_SIGNATURE)) {
		throw new Error('Invalid NTLM challenge received from server');
	}
	if (message.readUInt32LE(8) !== 2) {
		throw new Error(`Unexpected NTLM message type ${message.readUInt32LE(8)}`);
	}
	const flags = message.readUInt32LE(20);
	const unicode = (flags & NtlmFlags.NEGOTIATE_UNICODE) !== 0;
	const targetNameBuffer = readSecurityBuffer(message, 12);
	const targetInfo = message.length >= 48 ? readSecurityBuffer(message, 40) : Buffer.alloc(0);
	return {
		flags,
		serverChallenge: Buffer.from(message.subarray(24, 32)),
		targetName: targetNameBuffer.toString(unicode ? 'utf16le' : 'latin1'),
		targetInfo: Buffer.from(targetInfo),
	};
}

function findAvPair(targetInfo: Buffer, id: number): Buffer | undefined {
	let offset = 0;
	while (offset + 4 <= targetInfo.length) {
		const avId = targetInfo.readUInt16LE(offset);
		const avLength = targetInfo.readUInt16LE(offset + 2);
		if (avId === AV_EOL) return undefined;
		if (avId === id) return targetInfo.subarray(offset + 4, offset + 4 + avLength);
		offset += 4 + avLength;
	}
	return undefined;
}

/** Windows FILETIME (100ns ticks since 1601-01-01) as little-endian 64-bit. */
function fileTimeNow(): Buffer {
	const ticks = (BigInt(Date.now()) + 11644473600000n) * 10000n;
	const buffer = Buffer.alloc(8);
	buffer.writeBigUInt64LE(ticks);
	return buffer;
}

export interface Type3Options {
	/** For deterministic tests only. */
	clientNonce?: Buffer;
	timestamp?: Buffer;
}

export function createType3Message(
	challenge: NtlmChallenge,
	rawIdentity: NtlmIdentity,
	options: Type3Options = {},
): string {
	const identity = normalizeIdentity(rawIdentity);
	const domain = identity.domain || challenge.targetName || '';
	const username = identity.username;
	const workstation = (identity.workstation ?? '').toUpperCase();
	const unicode = (challenge.flags & NtlmFlags.NEGOTIATE_UNICODE) !== 0;
	const encode = (value: string) => Buffer.from(value, unicode ? 'utf16le' : 'latin1');

	const clientNonce = options.clientNonce ?? randomBytes(8);
	const serverTimestamp = findAvPair(challenge.targetInfo, AV_TIMESTAMP);
	const timestamp = options.timestamp ?? serverTimestamp ?? fileTimeNow();

	const v2Hash = ntlmv2Hash(username, identity.password, domain);

	const blob = Buffer.concat([
		Buffer.from([0x01, 0x01, 0x00, 0x00]),
		Buffer.alloc(4),
		timestamp,
		clientNonce,
		Buffer.alloc(4),
		challenge.targetInfo,
		Buffer.alloc(4),
	]);
	const ntProof = hmacMd5(v2Hash, challenge.serverChallenge, blob);
	const ntResponse = Buffer.concat([ntProof, blob]);

	// When the server sends MsvAvTimestamp the LMv2 response must be zeroed (MS-NLMP 3.1.5.1.2).
	const lmResponse = serverTimestamp
		? Buffer.alloc(24)
		: Buffer.concat([hmacMd5(v2Hash, challenge.serverChallenge, clientNonce), clientNonce]);

	const domainBuffer = encode(domain);
	const userBuffer = encode(username);
	const workstationBuffer = encode(workstation);
	const sessionKey = Buffer.alloc(0);

	const flags =
		(challenge.flags &
			(TYPE1_FLAGS | NtlmFlags.NEGOTIATE_TARGET_INFO) &
			~NtlmFlags.NEGOTIATE_KEY_EXCH &
			~(unicode ? NtlmFlags.NEGOTIATE_OEM : 0)) >>>
		0;

	const headerLength = 64;
	const payload = [lmResponse, ntResponse, domainBuffer, userBuffer, workstationBuffer, sessionKey];
	const header = Buffer.alloc(headerLength);
	NTLMSSP_SIGNATURE.copy(header, 0);
	header.writeUInt32LE(3, 8);

	let offset = headerLength;
	const writeSecurityBuffer = (position: number, data: Buffer) => {
		header.writeUInt16LE(data.length, position);
		header.writeUInt16LE(data.length, position + 2);
		header.writeUInt32LE(offset, position + 4);
		offset += data.length;
	};
	// Security buffers are written in the same order as the payload is concatenated.
	writeSecurityBuffer(12, lmResponse);
	writeSecurityBuffer(20, ntResponse);
	writeSecurityBuffer(28, domainBuffer);
	writeSecurityBuffer(36, userBuffer);
	writeSecurityBuffer(44, workstationBuffer);
	writeSecurityBuffer(52, sessionKey);
	header.writeUInt32LE(flags, 60);

	return Buffer.concat([header, ...payload]).toString('base64');
}

/**
 * Extracts the NTLM token from WWW-Authenticate headers. Servers may send it under the
 * "NTLM" scheme or wrapped as raw NTLMSSP in "Negotiate".
 */
export function extractChallengeToken(
	header: string | string[] | undefined,
): { scheme: 'NTLM' | 'Negotiate'; token: string } | undefined {
	if (!header) return undefined;
	const values = (Array.isArray(header) ? header : [header]).flatMap((value) => value.split(','));
	for (const raw of values) {
		const match = /^\s*(NTLM|Negotiate)\s+([A-Za-z0-9+/=]+)\s*$/i.exec(raw);
		if (!match) continue;
		const token = match[2];
		// Only accept raw NTLMSSP tokens (Kerberos/SPNEGO wrapped tokens are not supported).
		if (Buffer.from(token, 'base64').subarray(0, 8).equals(NTLMSSP_SIGNATURE)) {
			return { scheme: match[1].toLowerCase() === 'ntlm' ? 'NTLM' : 'Negotiate', token };
		}
	}
	return undefined;
}

export function supportedSchemes(header: string | string[] | undefined): string[] {
	if (!header) return [];
	return (Array.isArray(header) ? header : [header])
		.flatMap((value) => value.split(','))
		.map((value) => value.trim().split(/\s+/)[0])
		.filter(Boolean);
}
