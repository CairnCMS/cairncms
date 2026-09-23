import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import emitter from '../../../emitter.js';
import { ConfigApplyFailedException } from '../../../exceptions/config-apply-failed.js';
import { ConfigFolderInUseException } from '../../../exceptions/config-folder-in-use.js';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import { SettingsService } from '../../../services/settings.js';
import type {
	CairnConfig,
	ConfigApplySecurityContext,
	ConfigPlanChange,
	ConfigSettings,
} from '../../../types/config.js';
import { applyConfigPlan } from '../../apply-config-plan.js';
import { computeConfigPlan } from '../../compute-config-plan.js';
import { enrichConfigPlan } from '../../enrich-config-plan.js';
import { readCurrentConfig } from '../../get-config-snapshot.js';
import { serializeConfigPlan } from '../../serialize-config-plan.js';

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
		directus_settings: {
			collection: 'directus_settings',
			primary: 'id',
			singleton: true,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'integer', { nullable: false, generated: true }),
				project_name: field('project_name', 'string', { nullable: false, defaultValue: 'CairnCMS' }),
				project_descriptor: field('project_descriptor', 'string'),
				project_url: field('project_url', 'string'),
				default_language: field('default_language', 'string', { nullable: false, defaultValue: 'en-US' }),
				project_color: field('project_color', 'string'),
				public_note: field('public_note', 'text'),
				custom_css: field('custom_css', 'text'),
				module_bar: field('module_bar', 'json', { special: ['cast-json'] }),
				auth_password_policy: field('auth_password_policy', 'string'),
				auth_login_attempts: field('auth_login_attempts', 'integer', { defaultValue: 25 }),
				storage_asset_transform: field('storage_asset_transform', 'string', { defaultValue: 'all' }),
				storage_asset_presets: field('storage_asset_presets', 'json', { special: ['cast-json'] }),
				basemaps: field('basemaps', 'json', { special: ['cast-json'] }),
				custom_aspect_ratios: field('custom_aspect_ratios', 'json', { special: ['cast-json'] }),
				mapbox_key: field('mapbox_key', 'string'),
				storage_default_folder: field('storage_default_folder', 'uuid'),
			},
		},
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

describe('settings through the real apply engine on SQLite', () => {
	let db: Knex;
	const spies: MockInstance[] = [];

	beforeEach(async () => {
		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 1000,
		});

		await db.schema.createTable('directus_settings', (table) => {
			table.increments('id');
			table.string('project_name', 100).notNullable().defaultTo('CairnCMS');
			table.string('project_descriptor', 100);
			table.string('project_url', 255);
			table.string('default_language', 255).notNullable().defaultTo('en-US');
			table.string('project_color', 50);
			table.text('public_note');
			table.text('custom_css');
			table.json('module_bar');
			table.string('auth_password_policy', 100);
			table.integer('auth_login_attempts').defaultTo(25);
			table.string('storage_asset_transform', 7).defaultTo('all');
			table.json('storage_asset_presets');
			table.json('basemaps');
			table.json('custom_aspect_ratios');
			table.string('mapbox_key', 255);
			table.uuid('storage_default_folder');
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

		await db.schema.createTable('directus_fields', (table) => {
			table.increments('id');
			table.text('options');
		});
	});

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		await db.destroy();
	});

	async function currentRow(): Promise<Record<string, unknown> | undefined> {
		return db('directus_settings').first();
	}

	function desired(record: Partial<ConfigSettings>): CairnConfig {
		return {
			manifest: { version: 2, resources: ['settings'] },
			roles: [],
			permissions: [],
			folders: [],
			settings: [record],
		};
	}

	async function apply(target: CairnConfig): Promise<Awaited<ReturnType<typeof applyConfigPlan>>> {
		const { config: current, stateToken } = await readCurrentConfig({ database: db, schema, resources: ['settings'] });
		const plan = computeConfigPlan(current, target);

		return applyConfigPlan(plan, { database: db, schema, context: securityContext, expectedStateToken: stateToken });
	}

	async function snapshotSettings(): Promise<ConfigSettings> {
		const { config } = await readCurrentConfig({ database: db, schema, resources: ['settings'] });
		return config.settings[0]!;
	}

	it('inserts the settings row on the first apply and snapshots a complete record with preserved defaults', async () => {
		expect(await currentRow()).toBeUndefined();

		const result = await apply(desired({ project_name: 'Live', auth_login_attempts: 3 }));

		expect(result.settings).toEqual({ updated: ['project'] });

		expect(await snapshotSettings()).toEqual({
			project_name: 'Live',
			project_descriptor: null,
			project_url: null,
			default_language: 'en-US',
			project_color: null,
			public_note: null,
			custom_css: null,
			module_bar: null,
			auth_password_policy: null,
			auth_login_attempts: 3,
			storage_asset_transform: 'all',
			storage_asset_presets: null,
			basemaps: null,
			custom_aspect_ratios: null,
			mapbox_key: null,
			storage_default_folder: null,
		});
	});

	it('preserves both omitted non-default auth settings on an update', async () => {
		await db('directus_settings').insert({
			project_name: 'CairnCMS',
			auth_login_attempts: 3,
			auth_password_policy: '^.{12,}$',
		});

		await apply(desired({ project_name: 'Renamed' }));

		expect(await snapshotSettings()).toMatchObject({
			project_name: 'Renamed',
			auth_login_attempts: 3,
			auth_password_policy: '^.{12,}$',
		});
	});

	it('round-trips an explicit empty string through a snapshot, distinct from null', async () => {
		await db('directus_settings').insert({ project_name: 'CairnCMS', custom_css: 'body{}' });

		await apply(desired({ custom_css: '' }));

		expect((await snapshotSettings()).custom_css).toBe('');
	});

	it('fails the snapshot read as CONFIG_READ_FAILED when a stored structured array holds a null element', async () => {
		await apply(desired({ storage_asset_presets: [null] }));

		await expect(snapshotSettings()).rejects.toBeInstanceOf(ConfigReadFailedException);
		await expect(snapshotSettings()).rejects.toThrow('storage_asset_presets[0]');
	});

	it('snapshots a stored structured array of valid records', async () => {
		await apply(desired({ storage_asset_presets: [{ key: 'thumb' }] }));

		expect((await snapshotSettings()).storage_asset_presets).toEqual([{ key: 'thumb' }]);
	});

	it('is a no-op when the desired settings match the current row', async () => {
		await db('directus_settings').insert({
			project_name: 'CairnCMS',
			default_language: 'en-US',
			auth_login_attempts: 25,
			storage_asset_transform: 'all',
		});

		const { config: current, stateToken } = await readCurrentConfig({ database: db, schema, resources: ['settings'] });
		const plan = computeConfigPlan(current, { ...current, settings: current.settings });

		const result = await applyConfigPlan(plan, {
			database: db,
			schema,
			context: securityContext,
			expectedStateToken: stateToken,
		});

		expect(result.settings).toEqual({ updated: [] });
	});

	it('rolls back the real insert and leaves the table empty when a later step throws', async () => {
		const realUpsert = SettingsService.prototype.upsertSingleton;

		spies.push(
			vi
				.spyOn(SettingsService.prototype, 'upsertSingleton')
				.mockImplementation(async function (this: SettingsService, data: never, options: never) {
					await realUpsert.call(this, data, options);
					throw new Error('write barrier');
				})
		);

		await expect(apply(desired({ project_name: 'Live' }))).rejects.toBeInstanceOf(ConfigApplyFailedException);

		expect(await currentRow()).toBeUndefined();
	});

	describe('storage_default_folder handoff', () => {
		const OLD_ID = '00000000-0000-4000-8000-000000000001';

		async function seedOldDefault(): Promise<void> {
			await db('directus_folders').insert({ id: OLD_ID, name: 'old', key: 'old', parent: null });
			await db('directus_settings').insert({ project_name: 'CairnCMS', storage_default_folder: OLD_ID });
		}

		function retargetDesired(): CairnConfig {
			return {
				manifest: { version: 2, resources: ['folders', 'settings'] },
				roles: [],
				permissions: [],
				folders: [{ key: 'new', name: 'new', parent: null }],
				settings: [{ storage_default_folder: 'new' }],
			};
		}

		async function folderId(key: string): Promise<string | undefined> {
			const row = await db('directus_folders').where({ key }).first('id');
			return row?.['id'] as string | undefined;
		}

		function folderDelete(
			serialized: ReturnType<typeof serializeConfigPlan>,
			key: string
		): Extract<ConfigPlanChange, { kind: 'folders'; operation: 'delete' }> | undefined {
			return serialized.changes.find(
				(change): change is Extract<ConfigPlanChange, { kind: 'folders'; operation: 'delete' }> =>
					change.kind === 'folders' && change.operation === 'delete' && change.identity.key === key
			);
		}

		it('creates a folder, retargets the default to it, and deletes the old folder in one apply', async () => {
			await seedOldDefault();

			const { config: current, stateToken } = await readCurrentConfig({
				database: db,
				schema,
				resources: ['folders', 'settings'],
			});

			const result = await applyConfigPlan(computeConfigPlan(current, retargetDesired()), {
				database: db,
				schema,
				destructive: true,
				context: securityContext,
				expectedStateToken: stateToken,
			});

			expect(result.settings).toEqual({ updated: ['project'] });
			expect(await folderId('old')).toBeUndefined();
			expect((await currentRow())!['storage_default_folder']).toBe(await folderId('new'));
		});

		it('drops the deletion blocker for a folder the same apply retargets the default away from', async () => {
			await seedOldDefault();

			const { config: current } = await readCurrentConfig({ database: db, schema, resources: ['folders', 'settings'] });
			const desired = retargetDesired();
			const plan = computeConfigPlan(current, desired);
			const enrichment = await enrichConfigPlan(plan, desired, { schema, database: db });
			const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: 2 });

			expect(folderDelete(serialized, 'old')?.impact).toEqual([]);
		});

		it('drops only the storage_default_folder blocker on retarget, leaving other blocker categories', async () => {
			await seedOldDefault();
			await db('directus_files').insert({ id: '00000000-0000-4000-8000-0000000000f1', folder: OLD_ID });

			const { config: current } = await readCurrentConfig({ database: db, schema, resources: ['folders', 'settings'] });
			const desired = retargetDesired();
			const plan = computeConfigPlan(current, desired);
			const enrichment = await enrichConfigPlan(plan, desired, { schema, database: db });
			const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: 2 });

			expect(folderDelete(serialized, 'old')?.impact).toEqual([{ blockedBy: 'files' }]);
		});

		it('retains the deletion blocker when the apply does not retarget the default', async () => {
			await seedOldDefault();

			const { config: current } = await readCurrentConfig({ database: db, schema, resources: ['folders'] });

			const desired: CairnConfig = {
				manifest: { version: 2, resources: ['folders'] },
				roles: [],
				permissions: [],
				folders: [],
				settings: [],
			};

			const plan = computeConfigPlan(current, desired);
			const enrichment = await enrichConfigPlan(plan, desired, { schema, database: db });
			const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: 2 });

			expect(folderDelete(serialized, 'old')?.impact).toEqual([{ blockedBy: 'storage_default_folder' }]);
		});

		it('rolls the whole apply back when a filter restores the default to the doomed folder', async () => {
			await seedOldDefault();

			const { config: current, stateToken } = await readCurrentConfig({
				database: db,
				schema,
				resources: ['folders', 'settings'],
			});

			const plan = computeConfigPlan(current, retargetDesired());

			const restore = (payload: Record<string, unknown>): Record<string, unknown> => ({
				...payload,
				storage_default_folder: OLD_ID,
			});

			emitter.onFilter('settings.update', restore as never);

			try {
				await expect(
					applyConfigPlan(plan, {
						database: db,
						schema,
						destructive: true,
						context: securityContext,
						expectedStateToken: stateToken,
					})
				).rejects.toBeInstanceOf(ConfigFolderInUseException);
			} finally {
				emitter.offFilter('settings.update', restore as never);
			}

			expect(await folderId('new')).toBeUndefined();
			expect(await folderId('old')).toBe(OLD_ID);
			expect((await currentRow())!['storage_default_folder']).toBe(OLD_ID);
		});

		it('preserves an omitted default folder through a managed settings update', async () => {
			await seedOldDefault();

			const { config: current, stateToken } = await readCurrentConfig({
				database: db,
				schema,
				resources: ['settings'],
			});

			const desired: CairnConfig = {
				manifest: { version: 2, resources: ['settings'] },
				roles: [],
				permissions: [],
				folders: [],
				settings: [{ project_name: 'Renamed' }],
			};

			await applyConfigPlan(computeConfigPlan(current, desired), {
				database: db,
				schema,
				destructive: false,
				context: securityContext,
				expectedStateToken: stateToken,
			});

			const row = await currentRow();
			expect(row!['project_name']).toBe('Renamed');
			expect(row!['storage_default_folder']).toBe(OLD_ID);
		});

		it('blocks and rolls back a folder deletion while a managed settings update preserves the default', async () => {
			await seedOldDefault();

			const { config: current, stateToken } = await readCurrentConfig({
				database: db,
				schema,
				resources: ['folders', 'settings'],
			});

			const desired: CairnConfig = {
				manifest: { version: 2, resources: ['folders', 'settings'] },
				roles: [],
				permissions: [],
				folders: [],
				settings: [{ project_name: 'Renamed' }],
			};

			const plan = computeConfigPlan(current, desired);
			const enrichment = await enrichConfigPlan(plan, desired, { schema, database: db });
			const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: 2 });

			expect(folderDelete(serialized, 'old')?.impact).toEqual([{ blockedBy: 'storage_default_folder' }]);

			const error = await applyConfigPlan(plan, {
				database: db,
				schema,
				destructive: true,
				context: securityContext,
				expectedStateToken: stateToken,
			}).catch((err) => err);

			expect(error).toBeInstanceOf(ConfigFolderInUseException);
			expect(await folderId('old')).toBe(OLD_ID);

			const row = await currentRow();
			expect(row!['storage_default_folder']).toBe(OLD_ID);
			expect(row!['project_name']).toBe('CairnCMS');
		});

		it('clears the default with an explicit null in a managed settings update, permitting the deletion', async () => {
			await seedOldDefault();

			const { config: current, stateToken } = await readCurrentConfig({
				database: db,
				schema,
				resources: ['folders', 'settings'],
			});

			const desired: CairnConfig = {
				manifest: { version: 2, resources: ['folders', 'settings'] },
				roles: [],
				permissions: [],
				folders: [],
				settings: [{ storage_default_folder: null }],
			};

			const plan = computeConfigPlan(current, desired);
			const enrichment = await enrichConfigPlan(plan, desired, { schema, database: db });
			const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: 2 });

			expect(folderDelete(serialized, 'old')?.impact).toEqual([]);

			const result = await applyConfigPlan(plan, {
				database: db,
				schema,
				destructive: true,
				context: securityContext,
				expectedStateToken: stateToken,
			});

			expect(await folderId('old')).toBeUndefined();
			expect((await currentRow())!['storage_default_folder']).toBeNull();
			expect(result.settings).toEqual({ updated: ['project'] });
		});
	});
});
