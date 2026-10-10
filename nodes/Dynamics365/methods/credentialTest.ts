import type {
	ICredentialsDecrypted,
	ICredentialTestFunctions,
	IDataObject,
	INodeCredentialTestResult,
} from 'n8n-workflow';
import { buildConnection, parseBody } from '../transport';
import { ntlmRequest } from '../transport/httpClient';

export async function dynamics365NtlmApiTest(
	this: ICredentialTestFunctions,
	credential: ICredentialsDecrypted,
): Promise<INodeCredentialTestResult> {
	try {
		const connection = buildConnection(credential.data ?? {});
		const response = await ntlmRequest(connection.options, {
			method: 'GET',
			url: `${connection.baseUrl}/WhoAmI()`,
			headers: { Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
			timeout: 30_000,
		});
		const body = parseBody(response) as IDataObject | string | undefined;
		if (response.statusCode >= 400) {
			const error = typeof body === 'object' ? (body?.error as IDataObject | undefined) : undefined;
			return {
				status: 'Error',
				message: `HTTP ${response.statusCode}: ${error?.message ?? (typeof body === 'string' ? body.slice(0, 200) : 'request failed')}`,
			};
		}
		const userId = typeof body === 'object' ? body?.UserId : undefined;
		return { status: 'OK', message: userId ? `Connected as user ${userId}` : 'Connection successful' };
	} catch (error) {
		return { status: 'Error', message: (error as Error).message };
	}
}
