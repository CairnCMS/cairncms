import type { Accountability, SchemaOverview } from '@cairncms/types';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, parse } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GraphQLParams } from '../../types/index.js';

const MOCK_ENV: Record<string, unknown> = {
	NODE_ENV: 'test',
	LOG_LEVEL: 'info',
	LOG_STYLE: 'raw',
	SECRET: 'x',
	EXTENSIONS_PATH: '/tmp',
	EMAIL_TEMPLATES_PATH: '/tmp',
	STORAGE_LOCATIONS: 'local',
	GRAPHQL_INTROSPECTION: true,
};

vi.doMock('../../env', () => ({ default: MOCK_ENV, getEnv: () => MOCK_ENV }));
vi.doMock('../../database/index', () => ({ default: () => ({}) }));

const { GraphQLService } = await import('./index.js');
const { GraphQLValidationException } = await import('../../exceptions/index.js');

const minimalSchema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: 'Query',
		fields: { headline: { type: GraphQLString } },
	}),
});

async function executeAndReadValidationMessages(query: string): Promise<string> {
	const accountability: Accountability = { role: null, admin: true };
	const schema: SchemaOverview = { collections: {}, relations: [] };

	const service = new GraphQLService({ accountability, schema, scope: 'items' });
	vi.spyOn(service, 'getSchema').mockReturnValue(minimalSchema);

	const params: GraphQLParams = {
		query,
		variables: null,
		operationName: null,
		document: parse(query),
		contextValue: {},
	};

	try {
		await service.execute(params);
	} catch (error) {
		if (error instanceof GraphQLValidationException) {
			const { graphqlErrors = [] } = error.extensions as { graphqlErrors?: { message: string }[] };
			return graphqlErrors.map((graphqlError) => graphqlError.message).join(' ');
		}

		return `unexpected: ${(error as Error).message}`;
	}

	return '';
}

describe('Services / GraphQL / execute suggestion suppression', () => {
	afterEach(() => {
		MOCK_ENV['GRAPHQL_INTROSPECTION'] = true;
		vi.restoreAllMocks();
	});

	it('suppresses the suggestion through the service when introspection is disabled', async () => {
		MOCK_ENV['GRAPHQL_INTROSPECTION'] = false;

		const messages = await executeAndReadValidationMessages('{ headlin }');

		expect(messages).toContain('headlin');
		expect(messages).not.toContain('Did you mean');
		expect(messages).not.toContain('"headline"');
	});

	it('keeps the suggestion through the service when introspection is enabled', async () => {
		MOCK_ENV['GRAPHQL_INTROSPECTION'] = true;

		const messages = await executeAndReadValidationMessages('{ headlin }');

		expect(messages).toContain('Did you mean');
		expect(messages).toContain('headline');
	});
});
