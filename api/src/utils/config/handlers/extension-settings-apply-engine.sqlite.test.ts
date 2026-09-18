import type { SchemaOverview } from '@cairncms/types';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigApplyFailedException } from '../../../exceptions/config-apply-failed.js';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import { ConfigStateChangedException } from '../../../exceptions/config-state-changed.js';
import { ExtensionSettingsService } from '../../../services/extension-settings.js';
import type { CairnConfig, ConfigApplySecurityContext } from '../../../types/config.js';
import { applyConfigPlan } from '../../apply-config-plan.js';
import { computeConfigPlan } from '../../compute-config-plan.js';
import { readCurrentConfig } from '../../get-config-snapshot.js';
import { buildExtensionDeclarationSnapshot, desiredExtensionSubjects } from './extension-settings.js';

const managerState = vi.hoisted(() => ({ owners: [] as unknown[] }));

vi.mock('../../../database/index.js', () => ({ default: vi.fn(), getDatabaseClient: () => 'sqlite' }));

vi.mock('../../../cache.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cache.js')>()),
	flushCaches: vi.fn(async () => undefined),
}));

vi.mock('../../../extensions.js', () => ({
	getExtensionManager: () => ({
		isSettingsDiscoveryComplete: () => true,
		getSettingsOwners: () => managerState.owners,
	}),
}));

const TABLE = 'cairncms_extension_settings';
const WIDGET = '@cairncms/extension-widget';
const METRICS = 'cairncms-extension-metrics';

function owner(subject: string, declaration: Record<string, unknown>): unknown {
	return { subject, displaySubject: subject, status: 'available', declaration };
}

const WIDGET_DECLARATION = {
	color: { type: 'string', scope: 'global' },
	size: { type: 'number', scope: 'global' },
	ttl: { type: 'number', scope: 'global' },
};

const WIDGET_ORDINARY = owner(WIDGET, WIDGET_DECLARATION);

const schema = { collections: { articles: {} }, relations: [] } as unknown as SchemaOverview;

const securityContext: ConfigApplySecurityContext = {
	mode: 'system',
	reason: 'engine test apply',
	accountability: { user: null, role: null, admin: true, app: true, permissions: [], origin: 'config-cli' } as never,
};

function desired(global: Record<string, unknown>): CairnConfig {
	return {
		manifest: { version: 2, resources: ['extension-settings'] },
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [{ subject: WIDGET, global: global as never, collections: {} }],
	};
}

describe('extension settings through the real apply engine on SQLite', () => {
	let db: Knex;

	beforeEach(async () => {
		managerState.owners = [WIDGET_ORDINARY];

		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 1000,
		});

		await db.schema.createTable(TABLE, (table) => {
			table.uuid('id').primary();
			table.string('extension');
			table.string('scope');
			table.string('scope_key');
			table.string('key');
			table.text('value');
			table.unique(['extension', 'scope', 'scope_key', 'key']);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
	});

	async function seed(rows: Array<{ subject: string; key: string; value: string }>): Promise<void> {
		let index = 0;

		for (const row of rows) {
			index += 1;

			await db(TABLE).insert({
				id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
				extension: row.subject,
				scope: 'global',
				scope_key: '',
				key: row.key,
				value: row.value,
			});
		}
	}

	async function stored(subject: string): Promise<Record<string, unknown>> {
		const rows = await db(TABLE).where({ extension: subject, scope: 'global' }).select('key', 'value');
		return Object.fromEntries(rows.map((row) => [row.key, row.value]));
	}

	async function runApply(
		config: CairnConfig,
		options: { beforeApply?: () => void | Promise<void> } = {}
	): Promise<void> {
		const subjects = desiredExtensionSubjects(config['extension-settings']);
		const declarations = await buildExtensionDeclarationSnapshot();

		const { config: current, stateToken } = await readCurrentConfig({
			database: db,
			schema,
			resources: ['extension-settings'],
			extensionSettingsSubjects: subjects,
			extensionDeclarations: declarations,
		});

		const plan = computeConfigPlan(current, config, { extensionDeclarations: declarations });

		if (options.beforeApply) await options.beforeApply();

		await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: true,
			context: securityContext,
			expectedStateToken: stateToken,
			extensionDeclarations: declarations,
		});
	}

	it('commits an ordinary create, update, and delete when nothing fails', async () => {
		await seed([
			{ subject: WIDGET, key: 'color', value: '"blue"' },
			{ subject: WIDGET, key: 'size', value: '10' },
		]);

		await runApply(desired({ color: 'red', ttl: 5 }));

		expect(await stored(WIDGET)).toEqual({ color: '"red"', ttl: '5' });
	});

	it('rolls back the create when a later delete fails inside the transaction', async () => {
		await seed([{ subject: WIDGET, key: 'size', value: '10' }]);

		const original = ExtensionSettingsService.prototype.applyForConfig;
		let deleteReached = false;
		let createVisibleInTransaction = false;

		vi.spyOn(ExtensionSettingsService.prototype, 'applyForConfig').mockImplementation(async function (
			this: ExtensionSettingsService,
			write
		) {
			if (write.operation === 'delete') {
				deleteReached = true;

				// Use the transaction handle to observe the uncommitted create.
				const row = await this.knex(TABLE)
					.where({ extension: WIDGET, scope: 'global', scope_key: '', key: 'color' })
					.first('id');

				createVisibleInTransaction = row !== undefined;
				throw new Error('write barrier');
			}

			return original.call(this, write);
		});

		await expect(runApply(desired({ color: 'blue' }))).rejects.toBeInstanceOf(ConfigApplyFailedException);

		expect(deleteReached).toBe(true);
		expect(createVisibleInTransaction).toBe(true);

		expect(await stored(WIDGET)).toEqual({ size: '10' });
	});

	it('refuses the apply when the declaration classification drifts before mutation', async () => {
		const config = desired({ color: 'blue' });

		await expect(
			runApply(config, {
				beforeApply: () => {
					// Keep other declarations unchanged to isolate color's classification drift.
					managerState.owners = [
						owner(WIDGET, {
							...WIDGET_DECLARATION,
							color: { type: 'string', scope: 'global', secret: { source: 'inline' } },
						}),
					];
				},
			})
		).rejects.toBeInstanceOf(ConfigStateChangedException);

		expect(await stored(WIDGET)).toEqual({});
	});

	it('refuses the apply when a managed value changes concurrently before mutation', async () => {
		await seed([{ subject: WIDGET, key: 'color', value: '"blue"' }]);

		await expect(
			runApply(desired({ color: 'red' }), {
				beforeApply: async () => {
					await db(TABLE)
						.where({ extension: WIDGET, scope: 'global', scope_key: '', key: 'color' })
						.update({ value: '"green"' });
				},
			})
		).rejects.toBeInstanceOf(ConfigStateChangedException);

		expect(await stored(WIDGET)).toEqual({ color: '"green"' });
	});

	it('applies a scoped subject even when an unrelated eligible subject has a corrupt row', async () => {
		managerState.owners = [WIDGET_ORDINARY, owner(METRICS, { region: { type: 'string', scope: 'global' } })];

		await seed([
			{ subject: WIDGET, key: 'color', value: '"blue"' },
			{ subject: METRICS, key: 'region', value: 'not-json{' },
		]);

		await runApply(desired({ color: 'red' }));

		expect(await stored(WIDGET)).toEqual({ color: '"red"' });
		expect(await stored(METRICS)).toEqual({ region: 'not-json{' });
	});

	it('refuses the snapshot read on an unrepresentable stored scope tuple, leaving the row unchanged', async () => {
		await db(TABLE).insert({
			id: '00000000-0000-4000-8000-0000000000ff',
			extension: WIDGET,
			scope: 'global',
			scope_key: 'articles',
			key: 'color',
			value: '"blue"',
		});

		const subjects = desiredExtensionSubjects(desired({ color: 'red' })['extension-settings']);
		const declarations = await buildExtensionDeclarationSnapshot();

		await expect(
			readCurrentConfig({
				database: db,
				schema,
				resources: ['extension-settings'],
				extensionSettingsSubjects: subjects,
				extensionDeclarations: declarations,
			})
		).rejects.toBeInstanceOf(ConfigReadFailedException);

		const rows = await db(TABLE).where({ extension: WIDGET }).select('scope', 'scope_key', 'key', 'value');
		expect(rows).toEqual([{ scope: 'global', scope_key: 'articles', key: 'color', value: '"blue"' }]);
	});
});
