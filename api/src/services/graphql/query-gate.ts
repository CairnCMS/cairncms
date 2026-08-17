/** Every GraphQL transport must use this gate for parsing and validation. */

import type { DocumentNode, ValidationRule } from 'graphql';
import { NoSchemaIntrospectionCustomRule, parse, Source, specifiedRules } from 'graphql';
import { getEnv } from '../../env.js';
import { type BoundedSpec, type ConfigParseError, parseCount } from '../../utils/parse-config.js';

// This ceiling preserves integer precision; the configured limit provides the resource bound.
const TOKEN_LIMIT_SPEC: BoundedSpec = {
	envVar: 'GRAPHQL_QUERY_TOKEN_LIMIT',
	defaultValue: 5000,
	floor: 1,
	ceiling: Number.MAX_SAFE_INTEGER,
};

export type QueryTokenLimitResult = { ok: true; value: number } | { ok: false; error: ConfigParseError };

export function resolveQueryTokenLimit(source: Record<string, any>): QueryTokenLimitResult {
	return parseCount(source['GRAPHQL_QUERY_TOKEN_LIMIT'], TOKEN_LIMIT_SPEC);
}

export function getQueryTokenLimit(): number {
	const result = resolveQueryTokenLimit(getEnv());
	if (!result.ok) throw new Error(result.error.message);
	return result.value;
}

export function validateGraphQLQueryTokenLimit(): void {
	const result = resolveQueryTokenLimit(getEnv());
	if (!result.ok) throw new Error(result.error.message);
}

export function parseGraphQLQuery(query: string): DocumentNode {
	return parse(new Source(query), { maxTokens: getQueryTokenLimit() });
}

export function buildValidationRules(): ValidationRule[] {
	const rules = Array.from(specifiedRules);

	if (getEnv()['GRAPHQL_INTROSPECTION'] === false) {
		rules.push(NoSchemaIntrospectionCustomRule);
	}

	return rules;
}
