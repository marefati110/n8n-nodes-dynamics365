import type { IDataObject, IExecuteFunctions, INodeExecutionData, ResourceMapperValue } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { parseJsonParameter } from '../helpers/odata';

export type OperationResult = IDataObject | IDataObject[] | INodeExecutionData[] | undefined;

export function getOptions(this: IExecuteFunctions, i: number): IDataObject {
	return (this.getNodeParameter('options', i, {}) as IDataObject) ?? {};
}

export function requestTimeout(options: IDataObject): number | undefined {
	return options.timeout ? Number(options.timeout) : undefined;
}

/** Converts Luxon/Date objects and other n8n wrappers into plain JSON values. */
export function toPlainValue(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'object') {
		const maybeLuxon = value as { toISO?: () => string; isLuxonDateTime?: boolean };
		if (typeof maybeLuxon.toISO === 'function') return maybeLuxon.toISO();
		if (Array.isArray(value)) return value.map(toPlainValue);
		const result: IDataObject = {};
		for (const [key, inner] of Object.entries(value as IDataObject)) result[key] = toPlainValue(inner) as IDataObject;
		return result;
	}
	return value;
}

/** Reads values from a resourceMapper parameter, honoring auto-mapping of input data. */
export function getMappedValues(this: IExecuteFunctions, parameterName: string, i: number): IDataObject {
	const mapper = this.getNodeParameter(parameterName, i, { mappingMode: 'defineBelow', value: null }) as ResourceMapperValue;
	const schema = mapper.schema ?? [];
	const allowed = new Set(schema.filter((field) => !field.removed).map((field) => field.id));
	const values: IDataObject = {};

	if (mapper.mappingMode === 'autoMapInputData') {
		const json = this.getInputData()[i]?.json ?? {};
		for (const [key, value] of Object.entries(json)) {
			if (!allowed.size || allowed.has(key)) values[key] = toPlainValue(value) as IDataObject;
		}
		return values;
	}
	for (const [key, value] of Object.entries(mapper.value ?? {})) {
		if (value === undefined) continue;
		if (allowed.size && !allowed.has(key)) continue;
		values[key] = toPlainValue(value) as IDataObject;
	}
	return values;
}

export function getJsonObject(this: IExecuteFunctions, parameterName: string, i: number): IDataObject {
	const raw = this.getNodeParameter(parameterName, i, {});
	const parsed = parseJsonParameter.call(this, raw, parameterName, i);
	if (parsed === undefined) return {};
	if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
		throw new NodeOperationError(this.getNode(), `"${parameterName}" must be a JSON object`, { itemIndex: i });
	}
	return parsed as IDataObject;
}

export function wrapBody(response: unknown): IDataObject {
	if (response === undefined || response === null || response === '') return { success: true };
	if (typeof response !== 'object') return { value: response as string };
	const copy = { ...(response as IDataObject) };
	delete copy['@odata.context'];
	return copy;
}
