import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ConfigApplyFailedException } from '../../../exceptions/config-apply-failed.js';
import { ConfigStateChangedException } from '../../../exceptions/config-state-changed.js';
import { FoldersService } from '../../../services/folders.js';
import type { CairnConfig, ConfigApplySecurityContext } from '../../../types/config.js';
import { applyConfigPlan } from '../../apply-config-plan.js';
import { computeConfigPlan } from '../../compute-config-plan.js';
import { readCurrentConfig } from '../../get-config-snapshot.js';

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
});
