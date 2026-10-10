import type { IDataObject, INodeProperties, INodePropertyOptions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { DynamicsContext } from '../transport';
import { NAMESPACE } from './csdl';
import { getAttributes, LOOKUP_TYPES, type AttributeInfo } from './metadata';
import { isGuid, normalizeGuid, quoteODataString } from './odata';

/**
 * Builds OData $filter expressions from a list of conditions (column, operator, value),
 * formatting each value according to the column type read from metadata.
 */

type ValueKind = 'none' | 'single' | 'number' | 'list' | 'text';

interface OperatorDefinition {
	name: string;
	value: string;
	kind: ValueKind;
	/** OData comparison operator (eq, ne, gt, ...). */
	comparison?: string;
	/** OData string function (contains, startswith, endswith). */
	stringFunction?: string;
	negate?: boolean;
	/** Dynamics query function, e.g. LastXDays. */
	queryFunction?: string;
	description?: string;
}

const OPERATORS: OperatorDefinition[] = [
	{ name: 'Equals', value: 'equals', kind: 'single', comparison: 'eq' },
	{ name: 'Not Equals', value: 'notEquals', kind: 'single', comparison: 'ne' },
	{ name: 'Greater Than', value: 'greaterThan', kind: 'single', comparison: 'gt' },
	{ name: 'Greater Than or Equal', value: 'greaterThanOrEqual', kind: 'single', comparison: 'ge' },
	{ name: 'Less Than', value: 'lessThan', kind: 'single', comparison: 'lt' },
	{ name: 'Less Than or Equal', value: 'lessThanOrEqual', kind: 'single', comparison: 'le' },
	{ name: 'Is Empty (Null)', value: 'isNull', kind: 'none', comparison: 'eq' },
	{ name: 'Is Not Empty (Not Null)', value: 'isNotNull', kind: 'none', comparison: 'ne' },
	{ name: 'Contains', value: 'contains', kind: 'text', stringFunction: 'contains' },
	{ name: 'Does Not Contain', value: 'notContains', kind: 'text', stringFunction: 'contains', negate: true },
	{ name: 'Starts With', value: 'startsWith', kind: 'text', stringFunction: 'startswith' },
	{ name: 'Does Not Start With', value: 'notStartsWith', kind: 'text', stringFunction: 'startswith', negate: true },
	{ name: 'Ends With', value: 'endsWith', kind: 'text', stringFunction: 'endswith' },
	{ name: 'Does Not End With', value: 'notEndsWith', kind: 'text', stringFunction: 'endswith', negate: true },
	{ name: 'In List', value: 'in', kind: 'list', queryFunction: 'In', description: 'Comma-separated values' },
	{ name: 'Not In List', value: 'notIn', kind: 'list', queryFunction: 'NotIn', description: 'Comma-separated values' },
	{ name: 'Between', value: 'between', kind: 'list', queryFunction: 'Between', description: 'Two comma-separated values, e.g. 10,20' },
	{ name: 'Not Between', value: 'notBetween', kind: 'list', queryFunction: 'NotBetween', description: 'Two comma-separated values' },
	{ name: 'Choices Contain Values', value: 'containValues', kind: 'list', queryFunction: 'ContainValues', description: 'Multi-select choice column; comma-separated option values' },
	{ name: 'Choices Do Not Contain Values', value: 'doesNotContainValues', kind: 'list', queryFunction: 'DoesNotContainValues', description: 'Multi-select choice column; comma-separated option values' },
	{ name: 'Date: Today', value: 'today', kind: 'none', queryFunction: 'Today' },
	{ name: 'Date: Yesterday', value: 'yesterday', kind: 'none', queryFunction: 'Yesterday' },
	{ name: 'Date: Tomorrow', value: 'tomorrow', kind: 'none', queryFunction: 'Tomorrow' },
	{ name: 'Date: Last 7 Days', value: 'last7Days', kind: 'none', queryFunction: 'Last7Days' },
	{ name: 'Date: Next 7 Days', value: 'next7Days', kind: 'none', queryFunction: 'Next7Days' },
	{ name: 'Date: This Week', value: 'thisWeek', kind: 'none', queryFunction: 'ThisWeek' },
	{ name: 'Date: Last Week', value: 'lastWeek', kind: 'none', queryFunction: 'LastWeek' },
	{ name: 'Date: Next Week', value: 'nextWeek', kind: 'none', queryFunction: 'NextWeek' },
	{ name: 'Date: This Month', value: 'thisMonth', kind: 'none', queryFunction: 'ThisMonth' },
	{ name: 'Date: Last Month', value: 'lastMonth', kind: 'none', queryFunction: 'LastMonth' },
	{ name: 'Date: Next Month', value: 'nextMonth', kind: 'none', queryFunction: 'NextMonth' },
	{ name: 'Date: This Year', value: 'thisYear', kind: 'none', queryFunction: 'ThisYear' },
	{ name: 'Date: Last Year', value: 'lastYear', kind: 'none', queryFunction: 'LastYear' },
	{ name: 'Date: Next Year', value: 'nextYear', kind: 'none', queryFunction: 'NextYear' },
	{ name: 'Date: On', value: 'on', kind: 'single', queryFunction: 'On', description: 'Date such as 2026-01-31' },
	{ name: 'Date: On or Before', value: 'onOrBefore', kind: 'single', queryFunction: 'OnOrBefore' },
	{ name: 'Date: On or After', value: 'onOrAfter', kind: 'single', queryFunction: 'OnOrAfter' },
	{ name: 'Date: Last X Hours', value: 'lastXHours', kind: 'number', queryFunction: 'LastXHours' },
	{ name: 'Date: Last X Days', value: 'lastXDays', kind: 'number', queryFunction: 'LastXDays' },
	{ name: 'Date: Last X Weeks', value: 'lastXWeeks', kind: 'number', queryFunction: 'LastXWeeks' },
	{ name: 'Date: Last X Months', value: 'lastXMonths', kind: 'number', queryFunction: 'LastXMonths' },
	{ name: 'Date: Last X Years', value: 'lastXYears', kind: 'number', queryFunction: 'LastXYears' },
	{ name: 'Date: Next X Hours', value: 'nextXHours', kind: 'number', queryFunction: 'NextXHours' },
	{ name: 'Date: Next X Days', value: 'nextXDays', kind: 'number', queryFunction: 'NextXDays' },
	{ name: 'Date: Next X Weeks', value: 'nextXWeeks', kind: 'number', queryFunction: 'NextXWeeks' },
	{ name: 'Date: Next X Months', value: 'nextXMonths', kind: 'number', queryFunction: 'NextXMonths' },
	{ name: 'Date: Next X Years', value: 'nextXYears', kind: 'number', queryFunction: 'NextXYears' },
	{ name: 'Date: Older Than X Minutes', value: 'olderThanXMinutes', kind: 'number', queryFunction: 'OlderThanXMinutes' },
	{ name: 'Date: Older Than X Hours', value: 'olderThanXHours', kind: 'number', queryFunction: 'OlderThanXHours' },
	{ name: 'Date: Older Than X Days', value: 'olderThanXDays', kind: 'number', queryFunction: 'OlderThanXDays' },
	{ name: 'Date: Older Than X Weeks', value: 'olderThanXWeeks', kind: 'number', queryFunction: 'OlderThanXWeeks' },
	{ name: 'Date: Older Than X Months', value: 'olderThanXMonths', kind: 'number', queryFunction: 'OlderThanXMonths' },
	{ name: 'Date: Older Than X Years', value: 'olderThanXYears', kind: 'number', queryFunction: 'OlderThanXYears' },
	{ name: 'User: Equals Current User', value: 'equalUserId', kind: 'none', queryFunction: 'EqualUserId' },
	{ name: 'User: Not Equals Current User', value: 'notEqualUserId', kind: 'none', queryFunction: 'NotEqualUserId' },
	{ name: "User: Current User's Teams", value: 'equalUserTeams', kind: 'none', queryFunction: 'EqualUserTeams' },
	{ name: 'User: Current User or Their Teams', value: 'equalUserOrUserTeams', kind: 'none', queryFunction: 'EqualUserOrUserTeams' },
	{ name: "Business Unit: Equals Current User's", value: 'equalBusinessId', kind: 'none', queryFunction: 'EqualBusinessId' },
	{ name: "Business Unit: Not Equals Current User's", value: 'notEqualBusinessId', kind: 'none', queryFunction: 'NotEqualBusinessId' },
	{ name: 'Hierarchy: Above', value: 'above', kind: 'single', queryFunction: 'Above', description: 'Record ID' },
	{ name: 'Hierarchy: Above or Equal', value: 'aboveOrEqual', kind: 'single', queryFunction: 'AboveOrEqual', description: 'Record ID' },
	{ name: 'Hierarchy: Under', value: 'under', kind: 'single', queryFunction: 'Under', description: 'Record ID' },
	{ name: 'Hierarchy: Under or Equal', value: 'underOrEqual', kind: 'single', queryFunction: 'UnderOrEqual', description: 'Record ID' },
	{ name: 'Hierarchy: Not Under', value: 'notUnder', kind: 'single', queryFunction: 'NotUnder', description: 'Record ID' },
];

const OPERATOR_BY_VALUE = new Map(OPERATORS.map((operator) => [operator.value, operator]));
const NO_VALUE_OPERATORS = OPERATORS.filter((operator) => operator.kind === 'none').map((operator) => operator.value);

const NUMERIC_TYPES = new Set(['Integer', 'BigInt', 'Decimal', 'Double', 'Money', 'Picklist', 'State', 'Status']);

export interface FilterCondition {
	column: string;
	operator: string;
	value?: unknown;
}

/** UI for choosing between no filter, a condition builder and a raw OData expression. */
export function filterProperties(displayOptions: INodeProperties['displayOptions']): INodeProperties[] {
	const show = (mode: string[]) => ({
		...displayOptions,
		show: { ...displayOptions?.show, filterMode: mode },
	});
	return [
		{
			displayName: 'Filter',
			name: 'filterMode',
			type: 'options',
			options: [
				{ name: 'None', value: 'none' },
				{ name: 'Build Conditions', value: 'conditions', description: 'Pick columns, operators and values' },
				{ name: 'Raw OData Expression', value: 'raw', description: 'Write the $filter expression yourself' },
			],
			default: 'none',
			displayOptions,
		},
		{
			displayName: 'Conditions',
			name: 'filterConditions',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true, sortable: true },
			placeholder: 'Add Condition',
			default: {},
			displayOptions: show(['conditions']),
			options: [
				{
					displayName: 'Condition',
					name: 'condition',
					values: [
						{
							displayName: 'Column Name or ID',
							name: 'column',
							type: 'options',
							typeOptions: {
								loadOptionsMethod: 'getFilterAttributeOptions',
								loadOptionsDependsOn: ['entity', 'relationship'],
							},
							default: '',
							description:
								'Choose from the list, or specify a column (or a lookup path such as primarycontactid/fullname) using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
						},
						{
							displayName: 'Operator',
							name: 'operator',
							type: 'options',
							options: OPERATORS.map(
								(operator): INodePropertyOptions => ({
									name: operator.name,
									value: operator.value,
									...(operator.description ? { description: operator.description } : {}),
								}),
							),
							default: 'equals',
						},
						{
							displayName: 'Value',
							name: 'value',
							type: 'string',
							default: '',
							description:
								'Value to compare with. Use the option value (number) for choice columns, a GUID for lookups, an ISO date for date columns, and commas to separate list values.',
							displayOptions: { hide: { operator: NO_VALUE_OPERATORS } },
						},
					],
				},
			],
		},
		{
			displayName: 'Combine Conditions',
			name: 'filterCombinator',
			type: 'options',
			options: [
				{ name: 'AND (All Must Match)', value: 'and' },
				{ name: 'OR (Any Can Match)', value: 'or' },
			],
			default: 'and',
			displayOptions: show(['conditions']),
		},
		{
			displayName: 'Filter Expression',
			name: 'filterRaw',
			type: 'string',
			default: '',
			placeholder: "statecode eq 0 and contains(name,'contoso')",
			description: 'OData $filter expression',
			displayOptions: show(['raw']),
		},
	];
}

function splitList(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
	return String(value ?? '')
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

/** Formats a value as an OData literal for the column type; unknown columns are inferred. */
function formatLiteral(attribute: AttributeInfo | undefined, value: unknown): string {
	if (value === null || (typeof value === 'string' && value.trim().toLowerCase() === 'null')) return 'null';
	const text = typeof value === 'string' ? value.trim() : String(value);

	if (attribute) {
		if (LOOKUP_TYPES.has(attribute.attributeType) || attribute.attributeType === 'Uniqueidentifier') {
			return normalizeGuid(text);
		}
		if (NUMERIC_TYPES.has(attribute.attributeType)) {
			if (text === '' || isNaN(Number(text))) {
				throw new Error(`Column "${attribute.logicalName}" expects a number, got "${text}"`);
			}
			return String(Number(text));
		}
		if (attribute.attributeType === 'Boolean') {
			return ['true', '1', 'yes'].includes(text.toLowerCase()) ? 'true' : 'false';
		}
		if (attribute.attributeType === 'DateTime') return text;
		return quoteODataString(text);
	}

	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (/^(true|false)$/i.test(text)) return text.toLowerCase();
	if (/^-?\d+(\.\d+)?$/.test(text)) return text;
	if (isGuid(text)) return normalizeGuid(text);
	if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(text)) return text;
	return quoteODataString(text);
}

function buildCondition(attributes: Map<string, AttributeInfo>, condition: FilterCondition): string {
	const column = String(condition.column ?? '').trim();
	if (!column) throw new Error('Every filter condition needs a column');
	const operator = OPERATOR_BY_VALUE.get(condition.operator);
	if (!operator) throw new Error(`Unknown filter operator "${condition.operator}"`);

	const attribute = attributes.get(column);
	const isLookup = !!attribute && LOOKUP_TYPES.has(attribute.attributeType);
	// Comparisons on lookups use the _name_value property; query functions take the logical name.
	const property = isLookup ? `_${column}_value` : column;

	if (operator.queryFunction) {
		const call = `${NAMESPACE}.${operator.queryFunction}(PropertyName=${quoteODataString(column)}`;
		switch (operator.kind) {
			case 'none':
				return `${call})`;
			case 'number': {
				const amount = String(condition.value ?? '').trim();
				if (!/^\d+$/.test(amount)) throw new Error(`Operator "${operator.name}" expects a whole number, got "${amount}"`);
				return `${call},PropertyValue=${amount})`;
			}
			case 'list': {
				const values = splitList(condition.value);
				if (!values.length) throw new Error(`Operator "${operator.name}" needs at least one value`);
				if (operator.value.endsWith('etween') && values.length !== 2) {
					throw new Error(`Operator "${operator.name}" needs exactly two comma-separated values`);
				}
				const normalized = values.map((v) => (isGuid(v) ? normalizeGuid(v) : v));
				return `${call},PropertyValues=${JSON.stringify(normalized)})`;
			}
			default: {
				const raw = String(condition.value ?? '').trim();
				return `${call},PropertyValue=${quoteODataString(isGuid(raw) ? normalizeGuid(raw) : raw)})`;
			}
		}
	}

	if (operator.stringFunction) {
		const expression = `${operator.stringFunction}(${property},${quoteODataString(String(condition.value ?? ''))})`;
		return operator.negate ? `not ${expression}` : expression;
	}

	if (operator.kind === 'none') return `${property} ${operator.comparison} null`;
	return `${property} ${operator.comparison} ${formatLiteral(attribute, condition.value)}`;
}

/** Builds a $filter expression from conditions; values are typed using the table metadata. */
export async function buildFilterExpression(
	this: DynamicsContext,
	entityLogicalName: string,
	conditions: FilterCondition[],
	combinator: 'and' | 'or',
): Promise<string | undefined> {
	if (!conditions.some((condition) => String(condition.column ?? '').trim())) return undefined;
	return buildFilterFromAttributes(await getAttributes.call(this, entityLogicalName), conditions, combinator);
}

/** Pure variant of buildFilterExpression for already-loaded column metadata. */
export function buildFilterFromAttributes(
	attributeList: AttributeInfo[],
	conditions: FilterCondition[],
	combinator: 'and' | 'or',
): string | undefined {
	const active = conditions.filter((condition) => String(condition.column ?? '').trim());
	if (!active.length) return undefined;
	const attributes = new Map(attributeList.map((a) => [a.logicalName, a]));
	const parts = active.map((condition) => buildCondition(attributes, condition));
	if (parts.length === 1) return parts[0];
	return parts.map((part) => `(${part})`).join(` ${combinator} `);
}

/**
 * Reads the filter parameters (mode, conditions, combinator, raw expression) and returns the
 * $filter value, or undefined when no filter is set.
 */
export async function getFilterFromParameters(
	this: DynamicsContext,
	getParameter: (name: string, fallback: unknown) => unknown,
	entityLogicalName: string,
	itemIndex?: number,
): Promise<string | undefined> {
	const mode = getParameter('filterMode', 'none') as string;
	if (mode === 'raw') {
		const raw = String(getParameter('filterRaw', '') ?? '').trim();
		return raw || undefined;
	}
	if (mode !== 'conditions') return undefined;
	const conditions = (getParameter('filterConditions.condition', []) as IDataObject[]) as unknown as FilterCondition[];
	const combinator = (getParameter('filterCombinator', 'and') as 'and' | 'or') ?? 'and';
	try {
		return await buildFilterExpression.call(this, entityLogicalName, conditions ?? [], combinator);
	} catch (error) {
		throw new NodeOperationError(this.getNode(), `Invalid filter: ${(error as Error).message}`, { itemIndex });
	}
}
