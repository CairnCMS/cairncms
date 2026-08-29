import { buildSchema, NoSchemaIntrospectionCustomRule, parse } from 'graphql';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getEnv, refreshEnv } from '../../env.js';
import {
	buildValidationRules,
	getQueryTokenLimit,
	parseGraphQLQuery,
	resolveQueryTokenLimit,
	validateGraphQLDocument,
} from './query-gate.js';

// refreshEnv() replaces the object, so tests must read it through getEnv().
const env = () => getEnv() as Record<string, unknown>;

const CEILING = Number.MAX_SAFE_INTEGER;

// The two outer braces count toward the GraphQL token total.
function documentOfTokens(tokens: number): string {
	const names = Array.from({ length: tokens - 2 }, (_, index) => `f${index}`);
	return `{${names.join(' ')}}`;
}

function loadFromProcessEnv(raw: string) {
	const original = process.env['GRAPHQL_QUERY_TOKEN_LIMIT'];
	process.env['GRAPHQL_QUERY_TOKEN_LIMIT'] = raw;

	try {
		refreshEnv();
		return resolveQueryTokenLimit(getEnv());
	} finally {
		if (original === undefined) {
			delete process.env['GRAPHQL_QUERY_TOKEN_LIMIT'];
		} else {
			process.env['GRAPHQL_QUERY_TOKEN_LIMIT'] = original;
		}

		refreshEnv();
	}
}

describe('Services / GraphQL / query gate', () => {
	let originalLimit: unknown;
	let originalIntrospection: unknown;
	let originalPayloadSize: unknown;

	beforeAll(() => {
		originalLimit = env()['GRAPHQL_QUERY_TOKEN_LIMIT'];
		originalIntrospection = env()['GRAPHQL_INTROSPECTION'];
		originalPayloadSize = env()['MAX_PAYLOAD_SIZE'];
	});

	afterEach(() => {
		env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = originalLimit;
		env()['GRAPHQL_INTROSPECTION'] = originalIntrospection;
		env()['MAX_PAYLOAD_SIZE'] = originalPayloadSize;
	});

	describe('token limit configuration', () => {
		it('defaults to 5000 when unset', () => {
			delete env()['GRAPHQL_QUERY_TOKEN_LIMIT'];
			expect(getQueryTokenLimit()).toBe(5000);
		});

		it('respects an operator override', () => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 1234;
			expect(getQueryTokenLimit()).toBe(1234);
		});

		it('revalidates on every read so a later change takes effect', () => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 10;
			expect(getQueryTokenLimit()).toBe(10);

			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 20;
			expect(getQueryTokenLimit()).toBe(20);
		});

		it('reads the replacement object after refreshEnv rebuilds it', () => {
			const result = loadFromProcessEnv('123');
			expect(result).toStrictEqual({ ok: true, value: 123 });
		});

		it('accepts the representable maximum', () => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = CEILING;
			expect(getQueryTokenLimit()).toBe(CEILING);
		});

		it('is independent of MAX_PAYLOAD_SIZE', () => {
			env()['MAX_PAYLOAD_SIZE'] = '2kb';
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 100_000;
			expect(getQueryTokenLimit()).toBe(100_000);
		});

		it.each([
			['zero', 0],
			['negative', -1],
			['fractional', 1.5],
			['non-finite', Number.POSITIVE_INFINITY],
			['unsafe integer', 2 ** 53],
			['non-numeric', 'abc'],
		])('rejects a %s value', (_label, value) => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = value;
			expect(() => getQueryTokenLimit()).toThrowError(/GRAPHQL_QUERY_TOKEN_LIMIT/);
			expect(resolveQueryTokenLimit(getEnv()).ok).toBe(false);
		});
	});

	describe('real environment loading', () => {
		it('accepts a plain whole number', () => {
			expect(loadFromProcessEnv('750')).toStrictEqual({ ok: true, value: 750 });
		});

		it('rejects hexadecimal notation', () => {
			expect(loadFromProcessEnv('0x10').ok).toBe(false);
		});

		it('rejects a negative value', () => {
			expect(loadFromProcessEnv('-5').ok).toBe(false);
		});

		it('rejects a non-numeric value', () => {
			expect(loadFromProcessEnv('abc').ok).toBe(false);
		});

		it('accepts exponent notation normalized by the env loader', () => {
			expect(loadFromProcessEnv('1e3')).toStrictEqual({ ok: true, value: 1000 });
		});
	});

	describe('parseGraphQLQuery', () => {
		it('parses a document within the limit', () => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 5000;
			expect(() => parseGraphQLQuery('{ users { id } }')).not.toThrow();
		});

		it('accepts a document of exactly the configured token count', () => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 10;
			expect(() => parseGraphQLQuery(documentOfTokens(10))).not.toThrow();
		});

		it('rejects a document one token over the configured count', () => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 10;
			expect(() => parseGraphQLQuery(documentOfTokens(11))).toThrowError(/10 tokens/);
		});

		it('does not disclose document content in the overflow error', () => {
			env()['GRAPHQL_QUERY_TOKEN_LIMIT'] = 4;

			let message = '';

			try {
				parseGraphQLQuery('{ secretCollection { secretField } }');
			} catch (error) {
				message = (error as Error).message;
			}

			expect(message).not.toBe('');
			expect(message).not.toContain('secretCollection');
			expect(message).not.toContain('secretField');
		});
	});

	describe('schema suggestion suppression', () => {
		const schema = buildSchema(
			'enum Color { RED GREEN } type Thing { title: String } type Query { thing(name: String): Thing, color(c: Color): String }'
		);

		const messagesFor = (query: string) =>
			validateGraphQLDocument(schema, parse(query))
				.map((error) => error.message)
				.join(' ');

		const cases: [string, string, string][] = [
			['unknown field', '{ thing { titl } }', 'title'],
			['unknown argument', '{ thing(nam: "x") { title } }', 'name'],
			['unknown enum value', '{ color(c: RE) }', 'RED'],
			['unknown type', 'fragment F on Thin { title } { thing { title } }', 'Thing'],
		];

		it.each(cases)('suppresses the %s suggestion when introspection is disabled', (_label, query, leaked) => {
			env()['GRAPHQL_INTROSPECTION'] = false;

			const messages = messagesFor(query);

			expect(messages).not.toContain('Did you mean');
			expect(messages).not.toContain(leaked);
			expect(messages.length).toBeGreaterThan(0);
		});

		it.each(cases)('keeps the %s suggestion when introspection is enabled', (_label, query, suggested) => {
			env()['GRAPHQL_INTROSPECTION'] = true;

			const messages = messagesFor(query);

			expect(messages).toContain('Did you mean');
			expect(messages).toContain(suggested);
		});

		it('still reports the error itself, so a rejected query is not silently valid', () => {
			env()['GRAPHQL_INTROSPECTION'] = false;
			expect(messagesFor('{ thing { titl } }')).toContain('Cannot query field "titl"');
		});

		it('leaves an error carrying no suggestion untouched', () => {
			env()['GRAPHQL_INTROSPECTION'] = false;
			const [error] = validateGraphQLDocument(schema, parse('fragment Unused on Thing { title } { thing { title } }'));
			expect(error?.message).toBe('Fragment "Unused" is never used.');
		});
	});

	describe('buildValidationRules', () => {
		it('omits the introspection rule when introspection is enabled', () => {
			env()['GRAPHQL_INTROSPECTION'] = true;
			expect(buildValidationRules()).not.toContain(NoSchemaIntrospectionCustomRule);
		});

		it('includes the introspection rule when introspection is disabled', () => {
			env()['GRAPHQL_INTROSPECTION'] = false;
			expect(buildValidationRules()).toContain(NoSchemaIntrospectionCustomRule);
		});

		it('returns a fresh array so callers cannot mutate shared state', () => {
			const first = buildValidationRules();
			first.length = 0;
			expect(buildValidationRules().length).toBeGreaterThan(0);
		});
	});
});
