import type { ICredentialType, INodeProperties } from 'n8n-workflow';

export class Dynamics365NtlmApi implements ICredentialType {
	name = 'dynamics365NtlmApi';

	displayName = 'Dynamics 365 On-Premises (NTLM) API';

	icon = 'file:dynamics365.svg' as const;

	documentationUrl =
		'https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/overview';

	properties: INodeProperties[] = [
		{
			displayName: 'Organization URL',
			name: 'url',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'http://crm-server/OrganizationName',
			description:
				'URL of the CRM organization. The Web API path (/api/data/v9.x) is appended automatically; pasting a full Web API URL also works.',
		},
		{
			displayName: 'API Version',
			name: 'apiVersion',
			type: 'string',
			default: '9.1',
			required: true,
			placeholder: '9.1',
			description: 'Web API version, e.g. 9.0, 9.1 or 9.2',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'crmadmin or DOMAIN\\crmadmin',
			description: 'Windows account name. You may also write it as DOMAIN\\user or user@domain.',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Domain',
			name: 'domain',
			type: 'string',
			default: '',
			description:
				'Windows domain. Leave empty to use the domain in the username or the domain announced by the server.',
		},
		{
			displayName: 'Workstation',
			name: 'workstation',
			type: 'string',
			default: '',
			description: 'Optional workstation name sent during NTLM authentication',
		},
		{
			displayName: 'Ignore SSL Issues (Insecure)',
			name: 'ignoreSslIssues',
			type: 'boolean',
			default: false,
			description: 'Whether to connect even if SSL certificate validation fails',
		},
	];
}
