import type { Accountability, SchemaOverview } from '@cairncms/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import env from '../../env.js';
import { ForbiddenException } from '../../exceptions/index.js';
import { GraphQLService } from './index.js';

vi.mock('../../database/index.js', () => ({
	default: vi.fn(),
	getDatabase: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

const accountability: Accountability = {
	user: null,
	role: null,
	admin: false,
	app: false,
	ip: '127.0.0.1',
};

const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

let originalIntrospection: unknown;

beforeEach(() => {
	originalIntrospection = env['GRAPHQL_INTROSPECTION'];
	env['GRAPHQL_INTROSPECTION'] = true;
});

afterEach(() => {
	env['GRAPHQL_INTROSPECTION'] = originalIntrospection;
	vi.restoreAllMocks();
});

describe('GraphQLService.getSchema — SDL introspection gate (GHSA-wxwm-3fxv-mrvx)', () => {
	it('throws ForbiddenException for sdl with scope items when GRAPHQL_INTROSPECTION=false', () => {
		env['GRAPHQL_INTROSPECTION'] = false;
		const service = new GraphQLService({ accountability, schema, scope: 'items' });
		expect(() => service.getSchema('sdl')).toThrow(ForbiddenException);
	});

	it('throws ForbiddenException for sdl with scope system when GRAPHQL_INTROSPECTION=false', () => {
		env['GRAPHQL_INTROSPECTION'] = false;
		const service = new GraphQLService({ accountability, schema, scope: 'system' });
		expect(() => service.getSchema('sdl')).toThrow(ForbiddenException);
	});

	it('does not throw ForbiddenException for sdl when GRAPHQL_INTROSPECTION=true', () => {
		const service = new GraphQLService({ accountability, schema, scope: 'items' });
		expect(() => service.getSchema('sdl')).not.toThrow(ForbiddenException);
	});

	it('does not throw ForbiddenException for the default schema type regardless of GRAPHQL_INTROSPECTION', () => {
		env['GRAPHQL_INTROSPECTION'] = false;
		const offService = new GraphQLService({ accountability, schema, scope: 'items' });
		expect(() => offService.getSchema()).not.toThrow(ForbiddenException);

		env['GRAPHQL_INTROSPECTION'] = true;
		const onService = new GraphQLService({ accountability, schema, scope: 'items' });
		expect(() => onService.getSchema()).not.toThrow(ForbiddenException);
	});

	it('does not throw ForbiddenException for type schema regardless of GRAPHQL_INTROSPECTION', () => {
		env['GRAPHQL_INTROSPECTION'] = false;
		const offService = new GraphQLService({ accountability, schema, scope: 'system' });
		expect(() => offService.getSchema('schema')).not.toThrow(ForbiddenException);

		env['GRAPHQL_INTROSPECTION'] = true;
		const onService = new GraphQLService({ accountability, schema, scope: 'system' });
		expect(() => onService.getSchema('schema')).not.toThrow(ForbiddenException);
	});
});
