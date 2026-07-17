import type { Accountability, SchemaOverview } from '@cairncms/types';
import { GraphQLObjectType, GraphQLSchema, GraphQLString, parse } from 'graphql';
import { expect, test, vi } from 'vitest';
import type { GraphQLParams } from '../../types/index.js';

vi.doMock('../../env', () => {
	const MOCK_ENV = {
		NODE_ENV: 'test',
		LOG_LEVEL: 'info',
		LOG_STYLE: 'raw',
		SECRET: 'x',
		EXTENSIONS_PATH: '/tmp',
		EMAIL_TEMPLATES_PATH: '/tmp',
		STORAGE_LOCATIONS: 'local',
	};

	return { default: MOCK_ENV, getEnv: () => MOCK_ENV };
});

vi.doMock('../../database/index', () => ({ default: () => ({}) }));

const { GraphQLService } = await import('./index.js');

const SECRET = 'super-secret-token-value-1234567890';

const minimalSchema = new GraphQLSchema({
	query: new GraphQLObjectType({
		name: 'Query',
		fields: {
			echo: {
				type: GraphQLString,
				args: { token: { type: GraphQLString } },
				resolve: (_source, args) => {
					throw new Error(`resolver failed for ${args['token']}`);
				},
			},
		},
	}),
});

test('execute redacts a variable secret from a resolver error using the request variables', async () => {
	const accountability: Accountability = { role: null, admin: true };
	const schema: SchemaOverview = { collections: {}, relations: [] };

	const service = new GraphQLService({ accountability, schema, scope: 'items' });
	vi.spyOn(service, 'getSchema').mockReturnValue(minimalSchema);

	const params: GraphQLParams = {
		query: null,
		variables: { token: SECRET },
		operationName: null,
		document: parse('query ($token: String) { echo(token: $token) }'),
		contextValue: {},
	};

	const result = await service.execute(params);

	expect(result.errors).toHaveLength(1);
	expect(result.errors![0]!.message).toBe('resolver failed for --redact--');
});
