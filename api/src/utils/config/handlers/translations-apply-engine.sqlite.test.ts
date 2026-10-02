import type { SchemaOverview } from '@cairncms/types';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import knex, { type Knex } from 'knex';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import { ConfigStateChangedException } from '../../../exceptions/config-state-changed.js';
import { DestructiveChangesRequiredException } from '../../../exceptions/destructive-changes-required.js';
import { InvalidPayloadException } from '../../../exceptions/index.js';
import { RecordNotUniqueException } from '../../../exceptions/database/record-not-unique.js';
import { TranslationsService } from '../../../services/translations.js';
import type { CairnConfig, ConfigApplySecurityContext, ConfigTranslationsAuthored } from '../../../types/config.js';
import { applyConfigPlan } from '../../apply-config-plan.js';
import { computeConfigPlan } from '../../compute-config-plan.js';
import { readCurrentConfig } from '../../get-config-snapshot.js';
import { readConfigDirectory } from '../../read-config-directory.js';
import { validateDesiredConfig } from '../../validate-desired-config.js';
import { writeConfigDirectory } from '../../write-config-directory.js';
import { translationsDescriptor } from './translations.js';

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
		await runApplyOn(db, config, options);
	}

	async function runApplyOn(target: Knex, config: CairnConfig, options: { destructive?: boolean } = {}): Promise<void> {
		const { config: current, stateToken } = await readCurrentConfig({
			database: target,
			schema,
			resources: ['translations'],
		});

		const plan = computeConfigPlan(current, config);

		await applyConfigPlan(plan, {
			database: target,
			schema,
			destructive: options.destructive ?? true,
			context: securityContext,
			expectedStateToken: stateToken,
		});
	}

	async function runValidatedApply(config: CairnConfig, options: { destructive?: boolean } = {}): Promise<void> {
		const { config: current, currentRoleKeys, currentFolderKeys, currentFolderParents, stateToken } = await snapshot();

		const failures = validateDesiredConfig(config, {
			label: 'sqlite validated apply',
			references: 'current-state',
			currentRoleKeys,
			currentFolderKeys,
			currentFolderParents,
		});

		if (failures[0]) throw new ConfigInvalidException(failures[0].message);

		const plan = computeConfigPlan(current, config);

		await applyConfigPlan(plan, {
			database: db,
			schema,
			destructive: options.destructive ?? true,
			context: securityContext,
			expectedStateToken: stateToken,
		});
	}

	async function createNocaseDb(): Promise<Knex> {
		const target = knex.default({
			client: 'sqlite3',
			connection: { filename: ':memory:' },
			useNullAsDefault: true,
			pool: { min: 1, max: 1 },
		});

		await target.schema.createTable(TABLE, (table) => {
			table.uuid('id').primary();
			table.string('language').notNullable();
			table.specificType('key', 'text collate nocase').notNullable();
			table.text('value').notNullable();
			table.unique(['key', 'language']);
		});

		return target;
	}

	it('commits an ordinary create, update, and delete for a language', async () => {
		await seed([
			{ language: 'fr-FR', key: 'greeting', value: 'Bonjour' },
			{ language: 'fr-FR', key: 'old', value: 'obsolete' },
		]);

		await runApply(desired([{ language: 'fr-FR', translations: { greeting: 'Salut', fresh: 'Nouveau' } }]));

		expect(await stored('fr-FR')).toEqual({ greeting: 'Salut', fresh: 'Nouveau' });
	});

	it('holds a pending update behind the destructive gate with the deletion, then applies both', async () => {
		await seed([
			{ language: 'fr-FR', key: 'a', value: '1' },
			{ language: 'fr-FR', key: 'b', value: '2' },
		]);

		await expect(
			runApply(desired([{ language: 'fr-FR', translations: { a: 'updated' } }]), { destructive: false })
		).rejects.toBeInstanceOf(DestructiveChangesRequiredException);

		expect(await stored('fr-FR')).toEqual({ a: '1', b: '2' });

		await runApply(desired([{ language: 'fr-FR', translations: { a: 'updated' } }]), { destructive: true });

		expect(await stored('fr-FR')).toEqual({ a: 'updated' });
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
			await runValidatedApply(readBack);

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

	it('rejects an unpaired surrogate key and value through the shared validator in both modes', () => {
		const badKey = desired([
			{ language: 'fr-FR', translations: JSON.parse('{"a\\ud800": "x"}') as Record<string, string> },
		]);

		const badValue = desired([{ language: 'fr-FR', translations: { k: `v${String.fromCharCode(0xdc00)}` } }]);

		for (const document of [badKey, badValue]) {
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
		}
	});

	it('accepts a 255 code point astral key through the shared validator in both modes', () => {
		const document = desired([
			{ language: 'fr-FR', translations: { [String.fromCodePoint(0x1f600).repeat(255)]: 'ok' } },
		]);

		expect(
			validateDesiredConfig(document, {
				label: 'authored',
				references: 'current-state',
				currentRoleKeys: new Set<string>(),
				currentFolderKeys: new Set<string>(),
				currentFolderParents: new Map<string, string | null>(),
			})
		).toEqual([]);

		expect(validateDesiredConfig(document, { label: 'snapshot', references: 'server-snapshot' })).toEqual([]);
	});

	it('refuses a YAML-escaped unpaired surrogate value read from a directory', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-translations-yaml-'));

		try {
			await fs.mkdir(path.join(dir, 'translations'), { recursive: true });
			await fs.writeFile(path.join(dir, 'cairncms-config.yaml'), 'version: 2\nresources:\n  - translations\n', 'utf-8');

			await fs.writeFile(
				path.join(dir, 'translations', 'fr-FR.yaml'),
				'language: fr-FR\ntranslations:\n  k: "v\\uDC00"\n',
				'utf-8'
			);

			const readBack = await readConfigDirectory(dir);

			const failures = validateDesiredConfig(readBack, {
				label: 'yaml',
				references: 'current-state',
				currentRoleKeys: new Set<string>(),
				currentFolderKeys: new Set<string>(),
				currentFolderParents: new Map<string, string | null>(),
			});

			expect(failures.map((failure) => failure.code)).toContain('CONFIG_INVALID');
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('refuses a config with a malformed key before any mutation through validated apply', async () => {
		await seed([{ language: 'fr-FR', key: 'greeting', value: 'Bonjour' }]);

		const malformed = JSON.parse('{"a\\ud800": "x"}') as Record<string, string>;

		await expect(
			runValidatedApply(desired([{ language: 'fr-FR', translations: { greeting: 'Salut', ...malformed } }]))
		).rejects.toBeInstanceOf(ConfigInvalidException);

		expect(await stored('fr-FR')).toEqual({ greeting: 'Bonjour' });
	});

	it('preserves a 255 code point astral key and an astral value through the directory round trip', async () => {
		const astral = String.fromCodePoint(0x1f600);
		const key = astral.repeat(255);
		const value = `hi ${astral}`;

		await runApply(desired([{ language: 'fr-FR', translations: { [key]: value } }]));

		expect(await stored('fr-FR')).toEqual({ [key]: value });

		const { config } = await snapshot();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-translations-astral-'));

		try {
			await writeConfigDirectory(config, dir);
			const readBack = await readConfigDirectory(dir);

			expect(readBack.translations[0]!.translations![key]).toBe(value);

			await db(TABLE).del();
			await runValidatedApply(readBack);

			expect(await stored('fr-FR')).toEqual({ [key]: value });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it('fails the snapshot read on an ill-formed stored key from the service boundary', async () => {
		vi.spyOn(TranslationsService.prototype, 'readByQuery').mockResolvedValue([
			{ language: 'fr-FR', key: `a${String.fromCharCode(0xd800)}`, value: 'v' },
		] as never);

		const error = await snapshot().catch((err) => err);
		expect(error).toBeInstanceOf(ConfigReadFailedException);
		expect((error as Error).message).toContain('well-formed Unicode');
	});

	it('fails the snapshot read on an ill-formed stored value from the service boundary', async () => {
		vi.spyOn(TranslationsService.prototype, 'readByQuery').mockResolvedValue([
			{ language: 'fr-FR', key: 'k', value: `sentinel${String.fromCharCode(0xdc00)}` },
		] as never);

		const error = await snapshot().catch((err) => err);
		expect(error).toBeInstanceOf(ConfigReadFailedException);
		expect((error as Error).message).toContain('well-formed Unicode');
		expect((error as Error).message).not.toContain('sentinel');
	});

	it('refuses a case collision at apply on a NOCASE target, identifying the key without leaking driver detail', async () => {
		const nocaseDb = await createNocaseDb();

		try {
			await nocaseDb(TABLE).insert({ id: nextId(), language: 'fr-FR', key: 'Save', value: 'Enregistrer' });

			const error = await runApplyOn(
				nocaseDb,
				desired([{ language: 'fr-FR', translations: { Save: 'Enregistrer', save: 'Sauver' } }])
			).catch((err) => err);

			expect(error).toBeInstanceOf(ConfigInvalidException);

			const message = (error as Error).message;
			expect(message).toContain('fr-FR/save');
			expect(message).not.toContain('Sauver');
			expect(message).not.toContain('has to be unique');
			expect(message).not.toMatch(/sqlite|insert into|constraint failed/i);

			expect(await nocaseDb(TABLE).where({ language: 'fr-FR' }).select('key', 'value')).toEqual([
				{ key: 'Save', value: 'Enregistrer' },
			]);
		} finally {
			await nocaseDb.destroy();
		}
	});

	it('refuses a case-only rename even with destructive authorization on a NOCASE target', async () => {
		const nocaseDb = await createNocaseDb();

		try {
			await nocaseDb(TABLE).insert({ id: nextId(), language: 'fr-FR', key: 'Save', value: 'Enregistrer' });

			const error = await runApplyOn(
				nocaseDb,
				desired([{ language: 'fr-FR', translations: { save: 'Enregistrer' } }]),
				{ destructive: true }
			).catch((err) => err);

			expect(error).toBeInstanceOf(ConfigInvalidException);
			expect((error as Error).message).toContain('fr-FR/save');

			expect(await nocaseDb(TABLE).where({ language: 'fr-FR' }).select('key', 'value')).toEqual([
				{ key: 'Save', value: 'Enregistrer' },
			]);
		} finally {
			await nocaseDb.destroy();
		}
	});

	it('creates distinct case variants on a case-sensitive target', async () => {
		await runApply(desired([{ language: 'fr-FR', translations: { Save: 'Enregistrer', save: 'Sauver' } }]));

		expect(await stored('fr-FR')).toEqual({ Save: 'Enregistrer', save: 'Sauver' });
	});

	it('maps a uniqueness failure to a sanitized, bounded, value-free config error and re-throws unrelated errors', async () => {
		const context = {
			database: db,
			schema,
			securityContext,
			mutationOptions: {},
			dependency: () => undefined,
		} as never;

		const controlKey = `a${String.fromCharCode(7)}${'x'.repeat(300)}`;
		const creates = [{ identity: { language: 'fr-FR', key: controlKey }, value: 'Sauver' }];

		const createOne = vi.spyOn(TranslationsService.prototype, 'createOne');

		createOne.mockRejectedValueOnce(
			new RecordNotUniqueException('key', {
				collection: 'directus_translations',
				field: 'key',
				invalid: 'META_SENTINEL',
			})
		);

		const duplicate = (await translationsDescriptor.handler
			.applyCreates(creates, context)
			.catch((err) => err)) as Error;

		expect(duplicate).toBeInstanceOf(ConfigInvalidException);
		expect(duplicate.message).toContain('fr-FR');
		expect(duplicate.message).toContain('...');
		expect(duplicate.message).not.toContain('META_SENTINEL');
		expect(duplicate.message).not.toContain('Sauver');
		expect(duplicate.message).not.toContain('has to be unique');
		expect(duplicate.message).not.toContain(String.fromCharCode(7));
		expect(duplicate.message).not.toContain('x'.repeat(300));
		expect(duplicate.message.length).toBeLessThan(200);

		createOne.mockRejectedValueOnce(
			new InvalidPayloadException('Duplicate key and language combination META_SENTINEL')
		);

		const refused = (await translationsDescriptor.handler.applyCreates(creates, context).catch((err) => err)) as Error;
		expect(refused).toBeInstanceOf(ConfigInvalidException);
		expect(refused.message).not.toContain('META_SENTINEL');
		expect(refused.message).not.toContain('Duplicate key and language combination');

		createOne.mockRejectedValueOnce(new Error('connection reset'));

		await expect(translationsDescriptor.handler.applyCreates(creates, context)).rejects.toThrow('connection reset');
	});

	it('removes every language on a managed empty set only with destructive authorization', async () => {
		await seed([
			{ language: 'fr-FR', key: 'a', value: '1' },
			{ language: 'de-DE', key: 'b', value: '2' },
		]);

		await expect(runValidatedApply(desired([]), { destructive: false })).rejects.toBeInstanceOf(
			DestructiveChangesRequiredException
		);

		expect(await stored('fr-FR')).toEqual({ a: '1' });
		expect(await stored('de-DE')).toEqual({ b: '2' });

		await runValidatedApply(desired([]), { destructive: true });

		expect(await stored('fr-FR')).toEqual({});
		expect(await stored('de-DE')).toEqual({});
	});

	it('refuses an apply when another language is inserted after planning, preserving it', async () => {
		await seed([{ language: 'fr-FR', key: 'greeting', value: 'Bonjour' }]);

		const { config, stateToken } = await snapshot();
		const plan = computeConfigPlan(config, desired([{ language: 'fr-FR', translations: { greeting: 'Salut' } }]));

		await db(TABLE).insert({ id: nextId(), language: 'de-DE', key: 'greeting', value: 'Hallo' });

		await expect(
			applyConfigPlan(plan, {
				database: db,
				schema,
				destructive: true,
				context: securityContext,
				expectedStateToken: stateToken,
			})
		).rejects.toBeInstanceOf(ConfigStateChangedException);

		expect(await stored('fr-FR')).toEqual({ greeting: 'Bonjour' });
		expect(await stored('de-DE')).toEqual({ greeting: 'Hallo' });
	});

	it('refuses an apply when an in-scope value changes after planning, preserving that change', async () => {
		await seed([{ language: 'fr-FR', key: 'greeting', value: 'Bonjour' }]);

		const { config, stateToken } = await snapshot();
		const plan = computeConfigPlan(config, desired([{ language: 'fr-FR', translations: { greeting: 'Bonsoir' } }]));

		await db(TABLE).where({ language: 'fr-FR', key: 'greeting' }).update({ value: 'Coucou' });

		await expect(
			applyConfigPlan(plan, {
				database: db,
				schema,
				destructive: true,
				context: securityContext,
				expectedStateToken: stateToken,
			})
		).rejects.toBeInstanceOf(ConfigStateChangedException);

		expect(await stored('fr-FR')).toEqual({ greeting: 'Coucou' });
	});

	it('rolls back a confirmed create and update when a later delete fails', async () => {
		await seed([
			{ language: 'fr-FR', key: 'stale', value: 'old' },
			{ language: 'fr-FR', key: 'gone', value: 'remove' },
		]);

		let visibleInTransaction: Record<string, string> = {};

		const deleteOne = vi
			.spyOn(TranslationsService.prototype, 'deleteOne')
			.mockImplementation(async function (this: { knex: Knex }) {
				const rows = await this.knex(TABLE).where({ language: 'fr-FR' }).select('key', 'value');
				visibleInTransaction = Object.fromEntries(rows.map((row) => [row.key, row.value]));
				throw new Error('delete failed');
			});

		await expect(
			runApply(desired([{ language: 'fr-FR', translations: { stale: 'new', fresh: 'created' } }]))
		).rejects.toThrow();

		expect(deleteOne).toHaveBeenCalledTimes(1);
		expect(visibleInTransaction['fresh']).toBe('created');
		expect(visibleInTransaction['stale']).toBe('new');

		expect(await stored('fr-FR')).toEqual({ stale: 'old', gone: 'remove' });
	});

	it('refuses an own __proto__ document field through the shared validator in both modes', () => {
		const document = desired([
			JSON.parse('{"language": "fr-FR", "translations": {}, "__proto__": {"x": "y"}}') as ConfigTranslationsAuthored,
		]);

		const authored = validateDesiredConfig(document, {
			label: 'proto',
			references: 'current-state',
			currentRoleKeys: new Set<string>(),
			currentFolderKeys: new Set<string>(),
			currentFolderParents: new Map<string, string | null>(),
		});

		expect(authored.map((failure) => failure.code)).toContain('CONFIG_INVALID');
		expect(authored.map((failure) => failure.message).join('\n')).toContain('unknown field');

		expect(
			validateDesiredConfig(document, { label: 'proto', references: 'server-snapshot' }).map((failure) => failure.code)
		).toContain('CONFIG_INVALID');

		expect(({} as Record<string, unknown>)['x']).toBeUndefined();
	});
});
