import type {
	IDataObject,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	IPollFunctions,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
import { dynamicsApiRequestAllItems } from '../Dynamics365/transport';
import { resolveEntity, toWebApiPropertyNames } from '../Dynamics365/helpers/metadata';
import { buildCommonHeaders } from '../Dynamics365/helpers/odata';
import { getAttributeOptions, getEntityOptions } from '../Dynamics365/methods/loadOptions';
import { dynamics365NtlmApiTest } from '../Dynamics365/methods/credentialTest';

interface PollState {
	lastTimestamp?: string;
	/** Record IDs already emitted for `lastTimestamp` (timestamps only have second precision). */
	seenIds?: string[];
}

function toODataDate(value: string): string {
	return new Date(value).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export class Dynamics365Trigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Dynamics 365 (On-Premises) Trigger',
		name: 'dynamics365OnPremTrigger',
		icon: 'file:dynamics365.svg',
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["event"] + ": " + $parameter["entity"]}}',
		description: 'Starts the workflow when records are created or updated in Dynamics 365 on-premises',
		defaults: { name: 'Dynamics 365 Trigger' },
		polling: true,
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'dynamics365NtlmApi', required: true, testedBy: 'dynamics365NtlmApiTest' }],
		properties: [
			{
				displayName: 'Table (Entity) Name or ID',
				name: 'entity',
				type: 'options',
				typeOptions: { loadOptionsMethod: 'getEntityOptions' },
				required: true,
				default: '',
				description:
					'Choose from the list, or specify a logical name using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Event',
				name: 'event',
				type: 'options',
				options: [
					{ name: 'Record Created', value: 'created' },
					{ name: 'Record Updated', value: 'updated', description: 'Records modified after they were created' },
					{ name: 'Record Created or Updated', value: 'createdOrUpdated' },
				],
				default: 'created',
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add Option',
				default: {},
				options: [
					{
						displayName: 'Columns to Return',
						name: 'select',
						type: 'multiOptions',
						typeOptions: { loadOptionsMethod: 'getAttributeOptions', loadOptionsDependsOn: ['entity'] },
						default: [],
						description:
							'Columns to return. Leave empty to return all. Choose from the list, or specify IDs using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
					},
					{
						displayName: 'Additional Filter',
						name: 'filter',
						type: 'string',
						default: '',
						placeholder: 'statecode eq 0',
						description: 'Extra OData $filter combined with the time filter',
					},
					{
						displayName: 'Include Formatted Values',
						name: 'returnFormattedValues',
						type: 'boolean',
						default: false,
						description: 'Whether to include display labels for option sets, lookups and money values',
					},
					{
						displayName: 'Max Records Per Poll',
						name: 'limit',
						type: 'number',
						typeOptions: { minValue: 1 },
						default: 1000,
					},
				],
			},
		],
	};

	methods = {
		loadOptions: { getEntityOptions, getAttributeOptions },
		credentialTest: { dynamics365NtlmApiTest },
	};

	async poll(this: IPollFunctions): Promise<INodeExecutionData[][] | null> {
		const state = this.getWorkflowStaticData('node') as PollState;
		const entity = await resolveEntity.call(this, this.getNodeParameter('entity') as string);
		const event = this.getNodeParameter('event') as string;
		const options = this.getNodeParameter('options', {}) as IDataObject;
		const isManual = this.getMode() === 'manual';
		const timeField = event === 'created' ? 'createdon' : 'modifiedon';

		if (!state.lastTimestamp && !isManual) {
			// First activation: only report changes from now on.
			state.lastTimestamp = toODataDate(new Date().toISOString());
			state.seenIds = [];
			return null;
		}

		const select = Array.isArray(options.select) ? (options.select as string[]) : [];
		const selected = select.length
			? await toWebApiPropertyNames.call(this, entity.logicalName, [
					...new Set([...select, entity.primaryIdAttribute, 'createdon', 'modifiedon']),
				])
			: [];

		const filters: string[] = [];
		if (!isManual && state.lastTimestamp) filters.push(`${timeField} ge ${state.lastTimestamp}`);
		if (event === 'updated' && state.lastTimestamp) filters.push(`createdon lt ${state.lastTimestamp}`);
		if (options.filter) filters.push(`(${options.filter})`);

		const records = await dynamicsApiRequestAllItems.call(this, entity.entitySetName, {
			qs: {
				$select: selected.length ? selected.join(',') : undefined,
				$filter: filters.length ? filters.join(' and ') : undefined,
				$orderby: isManual ? `${timeField} desc` : `${timeField} asc`,
				$top: isManual ? 1 : undefined,
			},
			headers: buildCommonHeaders(options),
			limit: isManual ? 1 : Number(options.limit ?? 1000),
		});

		if (isManual) {
			return records.length ? [this.helpers.returnJsonArray(records)] : null;
		}

		const seen = new Set(state.seenIds ?? []);
		const fresh = records.filter((record) => {
			const id = String(record[entity.primaryIdAttribute]);
			const timestamp = record[timeField] ? toODataDate(String(record[timeField])) : undefined;
			return !(timestamp === state.lastTimestamp && seen.has(id));
		});

		if (records.length) {
			const newest = toODataDate(String(records[records.length - 1][timeField]));
			const idsAtNewest = records
				.filter((record) => toODataDate(String(record[timeField])) === newest)
				.map((record) => String(record[entity.primaryIdAttribute]));
			state.seenIds = newest === state.lastTimestamp ? [...seen, ...idsAtNewest] : idsAtNewest;
			state.lastTimestamp = newest;
		}

		return fresh.length ? [this.helpers.returnJsonArray(fresh)] : null;
	}
}
