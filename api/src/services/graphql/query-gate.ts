/** Every GraphQL transport must use this gate for parsing and validation. */

import type { DocumentNode, GraphQLSchema, ValidationRule } from 'graphql';
import { GraphQLError, NoSchemaIntrospectionCustomRule, parse, Source, specifiedRules, validate } from 'graphql';
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

// Near-match suggestions expose additional schema names when introspection is disabled.
const SCHEMA_SUGGESTION = /\s*Did you mean\b[\s\S]*$/;

function withoutSchemaSuggestion(error: GraphQLError): GraphQLError {
	const message = error.message.replace(SCHEMA_SUGGESTION, '');

	if (message === error.message) return error;

	return new GraphQLError(message, {
		nodes: error.nodes ?? null,
		source: error.source,
		positions: error.positions,
		path: error.path,
		originalError: error.originalError,
		extensions: error.extensions,
	});
}

export function validateGraphQLDocument(schema: GraphQLSchema, document: DocumentNode): readonly GraphQLError[] {
	const errors = validate(schema, document, buildValidationRules());

	if (getEnv()['GRAPHQL_INTROSPECTION'] !== false) return errors;

	return errors.map(withoutSchemaSuggestion);
}
