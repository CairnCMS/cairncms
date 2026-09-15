import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { ConfigApplyFailedException } from '../../../exceptions/config-apply-failed.js';
import { SettingsService } from '../../../services/settings.js';
import type { CairnConfig, ConfigApplySecurityContext, ConfigSettings } from '../../../types/config.js';
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
				module_bar: field('module_bar', 'json'),
				auth_password_policy: field('auth_password_policy', 'string'),
				auth_login_attempts: field('auth_login_attempts', 'integer', { defaultValue: 25 }),
				storage_asset_transform: field('storage_asset_transform', 'string', { defaultValue: 'all' }),
				storage_asset_presets: field('storage_asset_presets', 'json'),
				basemaps: field('basemaps', 'json'),
				custom_aspect_ratios: field('custom_aspect_ratios', 'json'),
				mapbox_key: field('mapbox_key', 'string'),
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
});
