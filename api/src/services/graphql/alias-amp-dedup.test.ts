import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { GraphQLResolveInfo } from 'graphql';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../database/index.js', () => ({
	default: vi.fn(),
	getDatabase: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
	getSchemaInspector: vi.fn().mockReturnValue({}),
}));

vi.mock('../../database/helpers/index.js', () => ({
	getHelpers: vi.fn().mockReturnValue({
		date: {},
		st: {},
		schema: { changeNullable: vi.fn() },
		sequence: {},
	}),
}));

const { GraphQLService } = await import('./index.js');
const { CollectionsService } = await import('../collections.js');
const { FieldsService } = await import('../fields.js');
const { RelationsService } = await import('../relations.js');
const { ServerService } = await import('../server.js');
const { SpecificationService } = await import('../specifications.js');
const { UsersService } = await import('../users.js');

const adminAccountability: Accountability = {
	user: 'admin-uuid',
	role: 'admin-role',
	admin: true,
	app: true,
	ip: '127.0.0.1',
};

function makeSchema(collection = 'probe_items'): SchemaOverview {
	return {
		collections: {
			[collection]: {
				collection,
				primary: 'id',
				singleton: false,
				note: null,
				sortField: null,
				accountability: 'all',
				fields: {
					id: {
						field: 'id',
						defaultValue: null,
						nullable: false,
						generated: false,
						type: 'integer',
						dbType: 'integer',
						precision: null,
						scale: null,
						special: [],
						note: null,
						alias: false,
						validation: null,
					},
				},
			},
		},
		relations: [],
	} as unknown as SchemaOverview;
}

function field(name: string) {
	return { kind: 'Field', name: { kind: 'Name', value: name } };
}

function arg(name: string, value: { kind: string; value: any }) {
	return { kind: 'Argument', name: { kind: 'Name', value: name }, value };
}

function makeInfo(opts: {
	fieldName: string;
	args?: any[];
	selections?: any[];
	variableValues?: Record<string, any>;
}): GraphQLResolveInfo {
	return {
		fieldName: opts.fieldName,
		fieldNodes: [
			{
				kind: 'Field',
				name: { kind: 'Name', value: opts.fieldName },
				arguments: opts.args ?? [],
				selectionSet: {
					kind: 'SelectionSet',
					selections: opts.selections ?? [field('id')],
				},
			},
		],
		fragments: {},
		variableValues: opts.variableValues ?? {},
	} as unknown as GraphQLResolveInfo;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('GraphQLService.resolveQuery — dedup contract (GHSA-ph52-67fq-75wj)', () => {
	it('two sequential calls with identical info call read exactly once', async () => {
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'items' });
		const readSpy = vi.spyOn(service, 'read').mockResolvedValue([{ id: 1 }] as any);

		await service.resolveQuery(makeInfo({ fieldName: 'probe_items' }));
		await service.resolveQuery(makeInfo({ fieldName: 'probe_items' }));

		expect(readSpy).toHaveBeenCalledOnce();
	});

	it('two concurrent calls with identical info call read exactly once', async () => {
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'items' });
		const readSpy = vi.spyOn(service, 'read').mockResolvedValue([{ id: 1 }] as any);

		await Promise.all([
			service.resolveQuery(makeInfo({ fieldName: 'probe_items' })),
			service.resolveQuery(makeInfo({ fieldName: 'probe_items' })),
		]);

		expect(readSpy).toHaveBeenCalledOnce();
	});

	it('different arg values produce separate read calls', async () => {
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'items' });
		const readSpy = vi.spyOn(service, 'read').mockResolvedValue([] as any);

		await service.resolveQuery(
			makeInfo({
				fieldName: 'probe_items',
				args: [arg('limit', { kind: 'IntValue', value: '5' })],
			})
		);
		await service.resolveQuery(
			makeInfo({
				fieldName: 'probe_items',
				args: [arg('limit', { kind: 'IntValue', value: '10' })],
			})
		);

		expect(readSpy).toHaveBeenCalledTimes(2);
	});

	it('fragment-spread expansion produces the same cache key as inline selections', async () => {
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'items' });
		const readSpy = vi.spyOn(service, 'read').mockResolvedValue([] as any);

		const inlineInfo = makeInfo({
			fieldName: 'probe_items',
			selections: [field('id'), field('name')],
		});

		const fragmentInfo: GraphQLResolveInfo = {
			fieldName: 'probe_items',
			fieldNodes: [
				{
					kind: 'Field',
					name: { kind: 'Name', value: 'probe_items' },
					arguments: [],
					selectionSet: {
						kind: 'SelectionSet',
						selections: [
							{ kind: 'FragmentSpread', name: { kind: 'Name', value: 'probeFields' } },
						],
					},
				},
			],
			fragments: {
				probeFields: {
					kind: 'FragmentDefinition',
					name: { kind: 'Name', value: 'probeFields' },
					typeCondition: { kind: 'NamedType', name: { kind: 'Name', value: 'probe_items' } },
					selectionSet: {
						kind: 'SelectionSet',
						selections: [field('id'), field('name')],
					},
				},
			},
			variableValues: {},
		} as unknown as GraphQLResolveInfo;

		await service.resolveQuery(inlineInfo);
		await service.resolveQuery(fragmentInfo);

		expect(readSpy).toHaveBeenCalledOnce();
	});

	it('different selection sets produce separate read calls', async () => {
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'items' });
		const readSpy = vi.spyOn(service, 'read').mockResolvedValue([] as any);

		await service.resolveQuery(
			makeInfo({
				fieldName: 'probe_items',
				selections: [field('id')],
			})
		);
		await service.resolveQuery(
			makeInfo({
				fieldName: 'probe_items',
				selections: [field('id'), field('name')],
			})
		);

		expect(readSpy).toHaveBeenCalledTimes(2);
	});
});

describe('GraphQLService system resolvers — dedup contract (GHSA-ph52-67fq-75wj)', () => {
	it('resolveSystemCollections shares one readByQuery across sequential calls', async () => {
		const spy = vi.spyOn(CollectionsService.prototype, 'readByQuery').mockResolvedValue([] as any);
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveSystemCollections();
		await (service as any).resolveSystemCollections();

		expect(spy).toHaveBeenCalledOnce();
	});

	it('resolveSystemFieldsInCollection keys on args: same args dedup, different args do not', async () => {
		const spy = vi.spyOn(FieldsService.prototype, 'readAll').mockResolvedValue([] as any);
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveSystemFieldsInCollection({ collection: 'a' });
		await (service as any).resolveSystemFieldsInCollection({ collection: 'a' });
		await (service as any).resolveSystemFieldsInCollection({ collection: 'b' });

		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy).toHaveBeenNthCalledWith(1, 'a');
		expect(spy).toHaveBeenNthCalledWith(2, 'b');
	});

	it('resolveSystemFieldsByName distinguishes argument combinations', async () => {
		const spy = vi.spyOn(FieldsService.prototype, 'readOne').mockResolvedValue({} as any);
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveSystemFieldsByName({ collection: 'a', field: 'x' });
		await (service as any).resolveSystemFieldsByName({ collection: 'a', field: 'y' });
		await (service as any).resolveSystemFieldsByName({ collection: 'b', field: 'x' });
		await (service as any).resolveSystemFieldsByName({ collection: 'a', field: 'x' });

		expect(spy).toHaveBeenCalledTimes(3);
	});

	it('resolveSystemRelations shares one readAll across sequential calls', async () => {
		const spy = vi.spyOn(RelationsService.prototype, 'readAll').mockResolvedValue([] as any);
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveSystemRelations();
		await (service as any).resolveSystemRelations();

		expect(spy).toHaveBeenCalledOnce();
	});

	it('resolveSystemUsersMe keys on selections: same selections dedup, different selections do not', async () => {
		const spy = vi.spyOn(UsersService.prototype, 'readOne').mockResolvedValue({} as any);
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		const infoA = makeInfo({
			fieldName: 'users_me',
			selections: [field('id')],
		});
		const infoB = makeInfo({
			fieldName: 'users_me',
			selections: [field('id'), field('email')],
		});

		await (service as any).resolveSystemUsersMe({}, infoA);
		await (service as any).resolveSystemUsersMe({}, infoA);
		await (service as any).resolveSystemUsersMe({}, infoB);

		expect(spy).toHaveBeenCalledTimes(2);
	});

	it('resolveSystemServerInfo shares one serverInfo across sequential calls', async () => {
		const spy = vi.spyOn(ServerService.prototype, 'serverInfo').mockResolvedValue({} as any);
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveSystemServerInfo();
		await (service as any).resolveSystemServerInfo();

		expect(spy).toHaveBeenCalledOnce();
	});

	it('resolveSystemServerSpecsOas shares one oas.generate across sequential calls', async () => {
		const sample = new SpecificationService({ accountability: adminAccountability, schema: makeSchema() });
		const oasProto = Object.getPrototypeOf(sample.oas);
		const spy = vi.spyOn(oasProto, 'generate').mockResolvedValue({} as any);

		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveSystemServerSpecsOas();
		await (service as any).resolveSystemServerSpecsOas();

		expect(spy).toHaveBeenCalledOnce();
	});

	it('resolveSystemServerSpecsGraphql keys on scope: same scope dedup, different scope does not', async () => {
		const spy = vi
			.spyOn(GraphQLService.prototype, 'getSchema')
			.mockImplementation(((type: any) => (type === 'sdl' ? 'sdl-stub' : ({} as any))) as any);
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveSystemServerSpecsGraphql({ scope: 'items' });
		await (service as any).resolveSystemServerSpecsGraphql({ scope: 'items' });
		await (service as any).resolveSystemServerSpecsGraphql({ scope: 'system' });

		expect(spy).toHaveBeenCalledTimes(2);
	});
});

describe('GraphQLService.resolveServerHealth — memoization preserved (advisory #3 regression)', () => {
	it('runs ServerService.health() exactly once across sequential calls', async () => {
		const spy = vi.spyOn(ServerService.prototype, 'health').mockResolvedValue({ status: 'ok' });
		const service = new GraphQLService({ accountability: adminAccountability, schema: makeSchema(), scope: 'system' });

		await (service as any).resolveServerHealth();
		await (service as any).resolveServerHealth();

		expect(spy).toHaveBeenCalledOnce();
	});
});
