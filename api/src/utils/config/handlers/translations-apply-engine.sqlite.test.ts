import type { SchemaOverview } from '@cairncms/types';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import { DestructiveChangesRequiredException } from '../../../exceptions/destructive-changes-required.js';
import { InvalidPayloadException } from '../../../exceptions/index.js';
import { TranslationsService } from '../../../services/translations.js';
import type { CairnConfig, ConfigApplySecurityContext, ConfigTranslationsAuthored } from '../../../types/config.js';
import { applyConfigPlan } from '../../apply-config-plan.js';
import { computeConfigPlan } from '../../compute-config-plan.js';
import { readCurrentConfig } from '../../get-config-snapshot.js';
import { readConfigDirectory } from '../../read-config-directory.js';
import { validateDesiredConfig } from '../../validate-desired-config.js';
import { writeConfigDirectory } from '../../write-config-directory.js';

vi.mock('../../../logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

vi.mock('../../../database/index.js', () => ({ default: vi.fn(), getDatabaseClient: () => 'sqlite' }));

vi.mock('../../../cache.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cache.js')>()),
	flushCaches: vi.fn(async () => undefined),
}));

const TABLE = 'directus_translations';

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
		directus_translations: {
			collection: 'directus_translations',
			primary: 'id',
			singleton: false,
			sortField: null,
			note: null,
			accountability: null,
			fields: {
				id: field('id', 'uuid', { nullable: false, special: ['uuid'] }),
				language: field('language', 'string', { nullable: false }),
				key: field('key', 'string', { nullable: false }),
				value: field('value', 'text', { nullable: false }),
			},
		},
	},
	relations: [],
} as unknown as SchemaOverview;

const securityContext: ConfigApplySecurityContext = {
	mode: 'system',
	reason: 'local config apply',
	accountability: { user: null, role: null, admin: true, app: true, permissions: [], origin: 'config-cli' } as never,
};

function desired(translations: ConfigTranslationsAuthored[]): CairnConfig {
	return {
		manifest: { version: 2, resources: ['translations'] },
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [],
		translations,
	};
}

describe('translations through the real apply engine on SQLite', () => {
	let db: Knex;
	let counter: number;

	function nextId(): string {
		counter += 1;
		return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
	}

	beforeEach(async () => {
		counter = 0;

		db = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
			acquireConnectionTimeout: 1000,
		});

		await db.schema.createTable(TABLE, (table) => {
			table.uuid('id').primary();
			table.string('language').notNullable();
			table.string('key').notNullable();
			table.text('value').notNullable();
			table.unique(['key', 'language']);
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await db.destroy();
	});

	async function seed(rows: Array<{ language: string; key: string; value: string }>): Promise<void> {
		for (const row of rows) await db(TABLE).insert({ id: nextId(), ...row });
	}

	async function stored(language: string): Promise<Record<string, string>> {
		const rows = await db(TABLE).where({ language }).select('key', 'value');
		const out: Record<string, string> = {};
		for (const row of rows) Object.defineProperty(out, row['key'], { value: row['value'], enumerable: true });
		return out;
	}

	async function snapshot(): Promise<Awaited<ReturnType<typeof readCurrentConfig>>> {
		return readCurrentConfig({ database: db, schema, resources: ['translations'] });
	}

	async function runApply(config: CairnConfig, options: { destructive?: boolean } = {}): Promise<void> {
		const { config: current, stateToken } = await snapshot();
		const plan = computeConfigPlan(current, config);

		await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: options.destructive ?? true,
			context: securityContext,
			expectedStateToken: stateToken,
		});
	}

	it('commits an ordinary create, update, and delete for a language', async () => {
		await seed([
			{ language: 'fr-FR', key: 'greeting', value: 'Bonjour' },
			{ language: 'fr-FR', key: 'old', value: 'obsolete' },
		]);

		await runApply(desired([{ language: 'fr-FR', translations: { greeting: 'Salut', fresh: 'Nouveau' } }]));

		expect(await stored('fr-FR')).toEqual({ greeting: 'Salut', fresh: 'Nouveau' });
	});

	it('refuses a complete-set deletion without the destructive flag and applies it with one', async () => {
		await seed([
			{ language: 'fr-FR', key: 'a', value: '1' },
			{ language: 'fr-FR', key: 'b', value: '2' },
		]);

		await expect(
			runApply(desired([{ language: 'fr-FR', translations: { a: '1' } }]), { destructive: false })
		).rejects.toBeInstanceOf(DestructiveChangesRequiredException);

		expect(await stored('fr-FR')).toEqual({ a: '1', b: '2' });

		await runApply(desired([{ language: 'fr-FR', translations: { a: '1' } }]), { destructive: true });

		expect(await stored('fr-FR')).toEqual({ a: '1' });
	});

	it('creates and reads back an empty key and a prototype-sensitive key as ordinary data', async () => {
		const map = JSON.parse('{"__proto__": "proto-value", "": "empty-key-value", "normal": "n"}') as Record<
			string,
			string
		>;

		await runApply(desired([{ language: 'fr-FR', translations: map }]));

		const rows = await db(TABLE).where({ language: 'fr-FR' }).select('key', 'value').orderBy('key');

		expect(rows).toEqual([
			{ key: '', value: 'empty-key-value' },
			{ key: '__proto__', value: 'proto-value' },
			{ key: 'normal', value: 'n' },
		]);

		const { config } = await snapshot();
		const [document] = config.translations;
		expect(Object.getOwnPropertyDescriptor(document!.translations, '__proto__')?.value).toBe('proto-value');
		expect(document!.translations!['']).toBe('empty-key-value');
	});

	it('refuses the snapshot read on a stored non-catalogue language, leaving the row unchanged', async () => {
		await seed([{ language: 'made-up', key: 'a', value: '1' }]);

		await expect(snapshot()).rejects.toBeInstanceOf(ConfigReadFailedException);

		const rows = await db(TABLE).select('language', 'key', 'value');
		expect(rows).toEqual([{ language: 'made-up', key: 'a', value: '1' }]);
	});

	it('refuses the snapshot read on a stored key over the length limit', async () => {
		await seed([{ language: 'fr-FR', key: 'a'.repeat(256), value: '1' }]);

		await expect(snapshot()).rejects.toBeInstanceOf(ConfigReadFailedException);
	});

	it('rejects a duplicate (key, language) through the service uniqueness guard', async () => {
		await seed([{ language: 'fr-FR', key: 'greeting', value: 'Bonjour' }]);

		const service = new TranslationsService({ knex: db, schema, accountability: securityContext.accountability });

		await expect(service.createOne({ language: 'fr-FR', key: 'greeting', value: 'Salut' })).rejects.toBeInstanceOf(
			InvalidPayloadException
		);
	});

	it('survives a service, snapshot, directory, shared-validation, and apply round-trip intact', async () => {
		const literalValue = '{{CAIRNCMS_CONFIG_LITERAL}}';

		const map = JSON.parse(
			`{"": "empty", "normal": "n", "project": "Project", "project.title": "Title", "placeholder": "${literalValue}", "__proto__": "proto"}`
		) as Record<string, string>;

		await runApply(desired([{ language: 'fr-FR', translations: map }]));

		const { config, currentRoleKeys, currentFolderKeys, currentFolderParents } = await snapshot();

		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-translations-roundtrip-'));

		try {
			await writeConfigDirectory(config, dir);
			const readBack = await readConfigDirectory(dir);

			const failures = validateDesiredConfig(readBack, {
				label: 'round-trip',
				references: 'current-state',
				currentRoleKeys,
				currentFolderKeys,
				currentFolderParents,
			});

			expect(failures).toEqual([]);

			const [document] = readBack.translations;
			expect(document!.language).toBe('fr-FR');
			expect(Object.getOwnPropertyDescriptor(document!.translations, '__proto__')?.value).toBe('proto');
			expect(document!.translations!['']).toBe('empty');
			expect(document!.translations!['project']).toBe('Project');
			expect(document!.translations!['project.title']).toBe('Title');
			expect(document!.translations!['placeholder']).toBe(literalValue);

			const plan = computeConfigPlan(config, readBack);
			expect(plan.translations.create).toEqual([]);
			expect(plan.translations.update).toEqual([]);
			expect(plan.translations.delete).toEqual([]);

			await db(TABLE).del();
			await runApply(readBack);

			const reapplied = await db(TABLE).where({ language: 'fr-FR' }).select('key', 'value').orderBy('key');

			expect(reapplied).toEqual([
				{ key: '', value: 'empty' },
				{ key: '__proto__', value: 'proto' },
				{ key: 'normal', value: 'n' },
				{ key: 'placeholder', value: literalValue },
				{ key: 'project', value: 'Project' },
				{ key: 'project.title', value: 'Title' },
			]);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('rejects a malformed own __proto__ value through the shared validator in both modes', async () => {
		const malformed = JSON.parse(
			'{"language": "fr-FR", "translations": {"__proto__": 5}}'
		) as ConfigTranslationsAuthored;

		const document = desired([malformed]);

		const authored = validateDesiredConfig(document, {
			label: 'authored',
			references: 'current-state',
			currentRoleKeys: new Set<string>(),
			currentFolderKeys: new Set<string>(),
			currentFolderParents: new Map<string, string | null>(),
		});

		expect(authored.map((failure) => failure.code)).toContain('CONFIG_INVALID');

		const portable = validateDesiredConfig(document, { label: 'snapshot', references: 'server-snapshot' });

		expect(portable.map((failure) => failure.code)).toContain('CONFIG_INVALID');
	});
});
