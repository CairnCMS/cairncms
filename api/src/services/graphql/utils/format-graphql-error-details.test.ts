import { GraphQLError, parse, Source } from 'graphql';
import { describe, expect, test } from 'vitest';
import { formatGraphQLErrorDetails } from './format-graphql-error-details.js';

describe('formatGraphQLErrorDetails', () => {
	const source = new Source('{ a }');
	const nodes = parse(source).definitions;

	test('keeps the message, locations, and path, and leaves out the stack', () => {
		const error = new GraphQLError('Cannot query field "a".', { nodes, path: ['query_abcd1234'] });

		expect(typeof error.stack).toBe('string');

		expect(formatGraphQLErrorDetails([error])).toEqual([
			{ message: 'Cannot query field "a".', locations: [{ line: 1, column: 1 }], path: ['query_abcd1234'] },
		]);
	});

	test('keeps extensions when an error has them', () => {
		const error = new GraphQLError('Failed.', { extensions: { code: 'EXAMPLE' } });

		expect(formatGraphQLErrorDetails([error])).toEqual([{ message: 'Failed.', extensions: { code: 'EXAMPLE' } }]);
	});

	test('returns one entry per error, in order', () => {
		const errors = [new GraphQLError('first'), new GraphQLError('second')];

		expect(formatGraphQLErrorDetails(errors).map((error) => error.message)).toEqual(['first', 'second']);
	});
});
