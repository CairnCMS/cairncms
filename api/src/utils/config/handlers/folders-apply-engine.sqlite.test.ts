import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import emitter from '../../../emitter.js';
import { ConfigApplyFailedException } from '../../../exceptions/config-apply-failed.js';
import { ConfigFolderInUseException } from '../../../exceptions/config-folder-in-use.js';
import { ConfigStateChangedException } from '../../../exceptions/config-state-changed.js';
import { InvalidPayloadException } from '../../../exceptions/index.js';
import { FoldersService } from '../../../services/folders.js';
import type { CairnConfig, ConfigApplySecurityContext, ConfigPlanChange } from '../../../types/config.js';
import { applyConfigPlan } from '../../apply-config-plan.js';
import { computeConfigPlan } from '../../compute-config-plan.js';
import { enrichConfigPlan } from '../../enrich-config-plan.js';
import { readCurrentConfig } from '../../get-config-snapshot.js';
import { serializeConfigPlan } from '../../serialize-config-plan.js';
import { validateDesiredConfig } from '../../validate-desired-config.js';

vi.mock('../../../database/index', () => ({
	default: vi.fn(),
	getDatabaseClient: () => 'sqlite',
}));

vi.mock('../../../cache.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cache.js')>()),
	flushCaches: vi.fn(async () => undefined),
}));

function field(name: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: type,
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
		...extra,
	};
}

const schema = {
	collections: {
		directus_folders: {
			collection: 'directus_folders',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'uuid', { nullable: false, special: ['uuid'] }),
				name: field('name', 'string', { nullable: false }),
				parent: field('parent', 'uuid'),
				key: field('key', 'string', { special: ['folder-key'] }),
			},
		},
	},
	relations: [],
} as unknown as SchemaOverview;

const securityContext: ConfigApplySecurityContext = {
	mode: 'system',
	reason: 'engine test apply',
	accountability: { user: null, role: null, admin: true, app: true, permissions: [], origin: 'config-cli' } as never,
};

function manifestFolders(): CairnConfig['manifest'] {
	return { version: 2, resources: ['folders'] };
}

describe('folders through the real apply engine on SQLite', () => {
	let db: Knex;
	let uuidByKey: Map<string, string>;
	const spies: MockInstance[] = [];

	function idFor(key: string): string {
		if (!uuidByKey.has(key)) {
			const hex = (uuidByKey.size + 1).toString(16).padStart(12, '0');
			uuidByKey.set(key, `00000000-0000-4000-8000-${hex}`);
		}

		return uuidByKey.get(key)!;
	}

	beforeEach(async () => {
		uuidByKey = new Map();

		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 1000,
		});

		await db.schema.createTable('directus_folders', (table) => {
			table.uuid('id').primary();
			table.string('name');
			table.uuid('parent');
			table.string('key').unique();
		});

		await db.schema.createTable('directus_files', (table) => {
			table.uuid('id').primary();
			table.uuid('folder');
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.uuid('storage_default_folder');
		});

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.text('options');
		});
	});

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		await db.destroy();
	});

	async function tree(): Promise<Record<string, string | null>> {
		const rows = await db('directus_folders').select('id', 'key', 'parent');
		const keyById = new Map(rows.map((row) => [row.id, row.key]));
		return Object.fromEntries(rows.map((row) => [row.key, row.parent === null ? null : keyById.get(row.parent)!]));
	}

	async function seed(entries: Array<{ key: string; parent: string | null }>): Promise<void> {
		for (const entry of entries) {
			await db('directus_folders').insert({
				id: idFor(entry.key),
				name: entry.key,
				key: entry.key,
				parent: entry.parent === null ? null : idFor(entry.parent),
			});
		}
	}

	async function snapshot(): Promise<Awaited<ReturnType<typeof readCurrentConfig>>> {
		return readCurrentConfig({ database: db, schema, resources: ['folders'] });
	}

	const MIXED_SEED = [
		{ key: 'root', parent: null },
		{ key: 'mover', parent: 'root' },
		{ key: 'victim', parent: 'root' },
	];

	function mixedDesired(): CairnConfig {
		return {
			manifest: manifestFolders(),
			roles: [],
			permissions: [],
			settings: [],
			folders: [
				{ key: 'root', name: 'root', parent: null },
				{ key: 'mover', name: 'mover', parent: null },
				{ key: 'fresh', name: 'fresh', parent: 'root' },
			],
		};
	}

	it('rolls back every folder write when a later delete fails', async () => {
		await seed(MIXED_SEED);

		const { config: current, stateToken } = await snapshot();
		const plan = computeConfigPlan(current, mixedDesired());

		spies.push(vi.spyOn(FoldersService.prototype, 'deleteOne').mockRejectedValue(new Error('write barrier')));

		await expect(
			applyConfigPlan(plan, {
				database: db,
				schema,
				destructive: true,
				context: securityContext,
				expectedStateToken: stateToken,
			})
		).rejects.toBeInstanceOf(ConfigApplyFailedException);

		expect(await tree()).toEqual({ root: null, mover: 'root', victim: 'root' });
	});

	it('commits the mixed create, reparent, and delete when nothing fails', async () => {
		await seed(MIXED_SEED);

		const { config: current, stateToken } = await snapshot();
		const plan = computeConfigPlan(current, mixedDesired());

		const result = await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: true,
			context: securityContext,
			expectedStateToken: stateToken,
		});

		expect(await tree()).toEqual({ root: null, mover: null, fresh: 'root' });
		expect(result.folders).toEqual({ created: ['fresh'], updated: ['mover'], deleted: ['victim'] });
	});

	it('refuses a stale plan with CONFIG_STATE_CHANGED and mutates nothing', async () => {
		await seed([
			{ key: 'root', parent: null },
			{ key: 'child', parent: 'root' },
		]);

		const { config: current, stateToken } = await snapshot();

		const desired: CairnConfig = {
			...current,
			folders: [...current.folders, { key: 'extra', name: 'extra', parent: 'root' }],
		};

		const plan = computeConfigPlan(current, desired);

		await db('directus_folders').where({ key: 'child' }).update({ parent: null });

		await expect(
			applyConfigPlan(plan, {
				database: db,
				schema,
				destructive: false,
				context: securityContext,
				expectedStateToken: stateToken,
			})
		).rejects.toBeInstanceOf(ConfigStateChangedException);

		expect(await tree()).toEqual({ root: null, child: null });
	});

	it('applies the plan when the observed state still matches the token', async () => {
		await seed([
			{ key: 'root', parent: null },
			{ key: 'child', parent: 'root' },
		]);

		const { config: current, stateToken } = await snapshot();

		const desired: CairnConfig = {
			...current,
			folders: [...current.folders, { key: 'extra', name: 'extra', parent: 'root' }],
		};

		const plan = computeConfigPlan(current, desired);

		const result = await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: false,
			context: securityContext,
			expectedStateToken: stateToken,
		});

		expect(await tree()).toEqual({ root: null, child: 'root', extra: 'root' });
		expect(result.folders.created).toEqual(['extra']);
	});

	it('refuses a config delete of a folder that still holds a file, and rolls back', async () => {
		await seed([{ key: 'root', parent: null }]);
		await db('directus_files').insert({ id: '00000000-0000-4000-8000-0000000000f1', folder: idFor('root') });

		const { config: current, stateToken } = await snapshot();
		const plan = computeConfigPlan(current, { ...current, folders: [] });

		const error = await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: true,
			context: securityContext,
			expectedStateToken: stateToken,
		}).catch((err) => err);

		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.key).toBe('root');
		expect(error.extensions.blockedBy).toBe('files');

		expect(await tree()).toEqual({ root: null });
	});

	it('previews the blocking category for each folder a destructive plan would delete', async () => {
		await seed([
			{ key: 'holder', parent: null },
			{ key: 'clean', parent: null },
		]);

		await db('directus_files').insert({ id: '00000000-0000-4000-8000-0000000000f2', folder: idFor('holder') });

		const { config: current } = await snapshot();
		const desired: CairnConfig = { ...current, folders: [] };
		const plan = computeConfigPlan(current, desired);
		const enrichment = await enrichConfigPlan(plan, desired, { schema, database: db });
		const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: 2 });

		const deletes = serialized.changes.filter(
			(change): change is Extract<ConfigPlanChange, { kind: 'folders'; operation: 'delete' }> =>
				change.kind === 'folders' && change.operation === 'delete'
		);

		const byKey = Object.fromEntries(deletes.map((change) => [change.identity.key, change.impact]));

		expect(byKey['holder']).toEqual([{ blockedBy: 'files' }]);
		expect(byKey['clean']).toEqual([]);
	});

	it('allows a reparent-then-delete in the same apply', async () => {
		await seed([
			{ key: 'root', parent: null },
			{ key: 'child', parent: 'root' },
			{ key: 'other', parent: null },
		]);

		const { config: current, stateToken } = await snapshot();

		const desired: CairnConfig = {
			...current,
			folders: [
				{ key: 'child', name: 'child', parent: 'other' },
				{ key: 'other', name: 'other', parent: null },
			],
		};

		const result = await applyConfigPlan(computeConfigPlan(current, desired), {
			database: db,
			schema,
			destructive: true,
			context: securityContext,
			expectedStateToken: stateToken,
		});

		expect(await tree()).toEqual({ child: 'other', other: null });
		expect(result.folders.deleted).toEqual(['root']);
	});

	it('refuses a filter-injected parent cycle through the apply engine and rolls back', async () => {
		await seed([
			{ key: 'a', parent: null },
			{ key: 'b', parent: 'a' },
			{ key: 'c', parent: 'b' },
		]);

		const { config: current, stateToken } = await snapshot();

		const desired: CairnConfig = {
			...current,
			folders: [
				{ key: 'a', name: 'A-renamed', parent: null },
				{ key: 'b', name: 'b', parent: 'a' },
				{ key: 'c', name: 'c', parent: 'b' },
			],
		};

		const inject = (payload: Record<string, unknown>): Record<string, unknown> => ({ ...payload, parent: idFor('c') });
		emitter.onFilter('folders.update', inject as never);

		try {
			await expect(
				applyConfigPlan(computeConfigPlan(current, desired), {
					database: db,
					schema,
					destructive: false,
					context: securityContext,
					expectedStateToken: stateToken,
				})
			).rejects.toBeInstanceOf(InvalidPayloadException);
		} finally {
			emitter.offFilter('folders.update', inject as never);
		}

		expect(await tree()).toEqual({ a: null, b: 'a', c: 'b' });
		expect(await db('directus_folders').where({ key: 'a' }).first()).toMatchObject({ name: 'a' });
	});

	it('rolls back the whole apply when a delete filter re-attaches a file after the pre-check', async () => {
		await seed([
			{ key: 'keep', parent: null },
			{ key: 'doomed', parent: null },
		]);

		const { config: current, stateToken } = await snapshot();

		const desired: CairnConfig = {
			...current,
			folders: [
				{ key: 'keep', name: 'keep-renamed', parent: null },
				{ key: 'fresh', name: 'fresh', parent: null },
			],
		};

		const attach = async (keys: unknown, _meta: unknown, context: { database: Knex }): Promise<unknown> => {
			await context
				.database('directus_files')
				.insert({ id: '00000000-0000-4000-8000-0000000000fa', folder: idFor('doomed') });

			return keys;
		};

		emitter.onFilter('folders.delete', attach as never);
		const dispatched = vi.spyOn(emitter, 'emitActionAndWait');
		spies.push(dispatched);

		try {
			await expect(
				applyConfigPlan(computeConfigPlan(current, desired), {
					database: db,
					schema,
					destructive: true,
					context: securityContext,
					expectedStateToken: stateToken,
				})
			).rejects.toBeInstanceOf(ConfigFolderInUseException);
		} finally {
			emitter.offFilter('folders.delete', attach as never);
		}

		expect(await tree()).toEqual({ keep: null, doomed: null });
		expect(await db('directus_folders').where({ key: 'keep' }).first()).toMatchObject({ name: 'keep' });
		expect(await db('directus_folders').where({ key: 'fresh' }).first()).toBeUndefined();
		expect(await db('directus_files').count({ n: '*' }).first()).toMatchObject({ n: 0 });
		expect(dispatched).not.toHaveBeenCalled();
	});

	it('preserves an omitted parent while renaming the folder in the same apply', async () => {
		await seed([
			{ key: 'root', parent: null },
			{ key: 'child', parent: 'root' },
		]);

		const { config: current, stateToken } = await snapshot();

		const desired: CairnConfig = {
			manifest: manifestFolders(),
			roles: [],
			permissions: [],
			settings: [],
			folders: [
				{ key: 'root', name: 'root', parent: null },
				{ key: 'child', name: 'Renamed' },
			],
		};

		const plan = computeConfigPlan(current, desired);
		const childUpdate = plan.folders.update.find((entry) => entry.key === 'child');
		expect(childUpdate?.changes).toHaveProperty('name');
		expect(childUpdate?.changes).not.toHaveProperty('parent');

		const result = await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: false,
			context: securityContext,
			expectedStateToken: stateToken,
		});

		expect(result.folders.updated).toContain('child');
		expect(await tree()).toEqual({ root: null, child: 'root' });
		expect(await db('directus_folders').where({ key: 'child' }).first()).toMatchObject({ name: 'Renamed' });
	});

	it('blocks deleting a folder whose only child preserves it through an omitted parent', async () => {
		await seed([
			{ key: 'root', parent: null },
			{ key: 'child', parent: 'root' },
		]);

		const { config: current, stateToken } = await snapshot();

		const desired: CairnConfig = {
			manifest: manifestFolders(),
			roles: [],
			permissions: [],
			settings: [],
			folders: [{ key: 'child', name: 'child' }],
		};

		const plan = computeConfigPlan(current, desired);

		const enrichment = await enrichConfigPlan(plan, desired, { schema, database: db });
		const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: 2 });

		const rootDelete = serialized.changes.find(
			(change): change is Extract<ConfigPlanChange, { kind: 'folders'; operation: 'delete' }> =>
				change.kind === 'folders' && change.operation === 'delete' && change.identity.key === 'root'
		);

		expect(rootDelete?.impact).toEqual([{ blockedBy: 'folders' }]);

		const error = await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: true,
			context: securityContext,
			expectedStateToken: stateToken,
		}).catch((err) => err);

		expect(error).toBeInstanceOf(ConfigFolderInUseException);
		expect(error.extensions.blockedBy).toBe('folders');
		expect(await tree()).toEqual({ root: null, child: 'root' });
	});

	it('rejects a preserved-edge cycle through readCurrentConfig and validateDesiredConfig', async () => {
		await seed([
			{ key: 'a', parent: null },
			{ key: 'b', parent: 'a' },
		]);

		const { currentRoleKeys, currentFolderParents } = await snapshot();

		const desired: CairnConfig = {
			manifest: manifestFolders(),
			roles: [],
			permissions: [],
			settings: [],
			folders: [
				{ key: 'a', name: 'a', parent: 'b' },
				{ key: 'b', name: 'b' },
			],
		};

		const failures = validateDesiredConfig(desired, {
			label: 'apply',
			references: 'current-state',
			currentRoleKeys,
			currentFolderParents,
		});

		expect(failures.map((failure) => failure.code)).toContain('CONFIG_INVALID');
	});
});
