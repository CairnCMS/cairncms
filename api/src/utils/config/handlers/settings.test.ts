import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { ConfigPlaceholderUnresolvedException } from '../../../exceptions/config-placeholder-unresolved.js';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import { SettingsService } from '../../../services/settings.js';
import type { ConfigSettings } from '../../../types/config.js';
import type { ApplyContext, ReadContext, ValidationContext } from '../descriptor.js';
import { buildRecordSchemas, validateConfigRecord } from '../../validate-desired-config.js';
import { settingsDescriptor, type SettingsKindTypes } from './settings.js';

function currentStateContext(
	options: { foldersManaged?: string[]; currentFolderKeys?: string[] } = {}
): ValidationContext {
	return {
		rolesManaged: false,
		declaredRoleKeys: new Set<string>(),
		foldersManaged: options.foldersManaged !== undefined,
		declaredFolderKeys: new Set(options.foldersManaged ?? []),
		references: 'current-state',
		currentRoleKeys: new Set<string>(),
		currentFolderKeys: new Set(options.currentFolderKeys ?? []),
		currentFolderParents: new Map<string, string | null>(),
	};
}

function serverSnapshotContext(options: { foldersManaged?: string[] } = {}): ValidationContext {
	return {
		rolesManaged: false,
		declaredRoleKeys: new Set<string>(),
		foldersManaged: options.foldersManaged !== undefined,
		declaredFolderKeys: new Set(options.foldersManaged ?? []),
		references: 'server-snapshot',
	};
}

const CONTEXT: ValidationContext = currentStateContext();

const COMPLETE_ROW: Record<string, unknown> = {
	id: 1,
	project_name: 'CairnCMS',
	project_descriptor: null,
	project_url: null,
	default_language: 'en-US',
	project_color: null,
	public_note: null,
	custom_css: null,
	module_bar: null,
	auth_password_policy: null,
	auth_login_attempts: 25,
	storage_asset_transform: 'all',
	storage_asset_presets: null,
	basemaps: null,
	custom_aspect_ratios: null,
	mapbox_key: null,
	storage_default_folder: null,
};

const COMPLETE_RECORD: ConfigSettings = {
	project_name: 'CairnCMS',
	project_descriptor: null,
	project_url: null,
	default_language: 'en-US',
	project_color: null,
	public_note: null,
	custom_css: null,
	module_bar: null,
	auth_password_policy: null,
	auth_login_attempts: 25,
	storage_asset_transform: 'all',
	storage_asset_presets: null,
	basemaps: null,
	custom_aspect_ratios: null,
	mapbox_key: null,
	storage_default_folder: null,
};

const NO_FOLDER_DB = {
	select: () => NO_FOLDER_DB,
	from: () => NO_FOLDER_DB,
	where: () => NO_FOLDER_DB,
	first: async () => undefined,
} as unknown as Knex;

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...COMPLETE_ROW, ...overrides };
}

function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
	const copy = { ...source };
	delete copy[key];
	return copy;
}

function readContext(
	readMode: 'full' | 'identity' = 'full',
	folderKeyById: Map<string, string> = new Map(),
	database: Knex = NO_FOLDER_DB
): ReadContext<SettingsKindTypes> {
	return {
		database,
		schema: {} as SchemaOverview,
		readMode,
		dependency: (() => ({ currentFolderKeys: new Set(folderKeyById.values()), folderKeyById })) as never,
	};
}

function applyContext(folderIdByKey: Map<string, string> = new Map()): ApplyContext<SettingsKindTypes> {
	return {
		database: {} as Knex,
		schema: {} as SchemaOverview,
		securityContext: { mode: 'system', reason: 'local config apply', accountability: {} as never },
		mutationOptions: {
			autoPurgeCache: false,
			autoPurgeSystemCache: false,
			bypassLimits: true,
			bypassEmitAction: () => undefined,
		},
		dependency: (() => ({ folderIdByKey })) as never,
	};
}

function mockRead(value: Record<string, unknown>): void {
	vi.spyOn(SettingsService.prototype, 'readSingleton').mockResolvedValue(value as never);
}

describe('settings validateDesired cardinality', () => {
	function codes(documents: ConfigSettings[]): string[] {
		return settingsDescriptor.handler.validateDesired(documents, documents, CONTEXT).map((failure) => failure.code);
	}

	it('accepts exactly one record', () => {
		expect(codes([{}])).toEqual([]);
	});

	it('rejects an empty settings set', () => {
		expect(codes([])).toEqual(['CONFIG_INVALID']);
	});

	it('rejects more than one settings record', () => {
		expect(codes([{}, {}])).toEqual(['CONFIG_INVALID']);
	});
});

describe('settings validateDesired folder reference', () => {
	function codes(document: ConfigSettings, context: ValidationContext): string[] {
		return settingsDescriptor.handler.validateDesired([document], [document], context).map((failure) => failure.code);
	}

	it('does not check an omitted or explicit-null reference', () => {
		expect(codes({}, currentStateContext())).toEqual([]);
		expect(codes({ storage_default_folder: null }, currentStateContext())).toEqual([]);
	});

	it('accepts a declared folder key when folders are managed', () => {
		expect(codes({ storage_default_folder: 'uploads' }, currentStateContext({ foldersManaged: ['uploads'] }))).toEqual(
			[]
		);
	});

	it('rejects a reference no folder file declares when folders are managed', () => {
		expect(codes({ storage_default_folder: 'ghost' }, currentStateContext({ foldersManaged: ['uploads'] }))).toEqual([
			'CONFIG_INVALID',
		]);
	});

	it('accepts a live folder key in current-state mode when folders are unmanaged', () => {
		expect(
			codes({ storage_default_folder: 'uploads' }, currentStateContext({ currentFolderKeys: ['uploads'] }))
		).toEqual([]);
	});

	it('rejects a reference absent from the database in current-state mode when folders are unmanaged', () => {
		expect(codes({ storage_default_folder: 'ghost' }, currentStateContext({ currentFolderKeys: ['uploads'] }))).toEqual(
			['CONFIG_INVALID']
		);
	});

	it('accepts any reference in server-snapshot mode without a local folder check', () => {
		expect(codes({ storage_default_folder: 'ghost' }, serverSnapshotContext())).toEqual([]);
	});
});

describe('settings readCurrent', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('materializes null-default columns as null on an empty table', async () => {
		mockRead({
			id: null,
			project_name: 'CairnCMS',
			default_language: 'en-US',
			auth_login_attempts: 25,
			storage_asset_transform: 'all',
		});

		const result = await settingsDescriptor.handler.readCurrent(readContext());

		expect(result.records).toEqual([COMPLETE_RECORD]);
	});

	it('reads an existing row into a complete record', async () => {
		mockRead(row({ auth_login_attempts: 3, module_bar: [{ id: 'nav' }], custom_css: '' }));

		const result = await settingsDescriptor.handler.readCurrent(readContext());

		expect(result.records[0]).toMatchObject({ auth_login_attempts: 3, module_bar: [{ id: 'nav' }], custom_css: '' });
	});

	it('fails closed when an existing row is missing a managed column', async () => {
		mockRead(without(COMPLETE_ROW, 'auth_password_policy'));

		await expect(settingsDescriptor.handler.readCurrent(readContext())).rejects.toBeInstanceOf(
			ConfigReadFailedException
		);
	});

	it('fails closed when the read omits the identity column, rather than fabricating defaults', async () => {
		mockRead(without(COMPLETE_ROW, 'id'));

		await expect(settingsDescriptor.handler.readCurrent(readContext())).rejects.toBeInstanceOf(
			ConfigReadFailedException
		);
	});

	it('fails closed when a json-array column does not read as an array', async () => {
		mockRead(row({ module_bar: '[malformed' }));

		await expect(settingsDescriptor.handler.readCurrent(readContext())).rejects.toBeInstanceOf(
			ConfigReadFailedException
		);
	});

	it('resolves a stored folder id to its config key through the folders dependency', async () => {
		const id = '00000000-0000-4000-8000-000000000001';
		mockRead(row({ storage_default_folder: id }));

		const result = await settingsDescriptor.handler.readCurrent(readContext('full', new Map([[id, 'uploads']])));

		expect(result.records[0]!.storage_default_folder).toBe('uploads');
	});

	it('fails closed when a stored folder id resolves to no folder', async () => {
		mockRead(row({ storage_default_folder: '00000000-0000-4000-8000-0000000000ff' }));

		await expect(settingsDescriptor.handler.readCurrent(readContext('full', new Map()))).rejects.toBeInstanceOf(
			ConfigReadFailedException
		);
	});

	it('fails closed when an existing row is missing the storage_default_folder column', async () => {
		mockRead(without(COMPLETE_ROW, 'storage_default_folder'));

		await expect(settingsDescriptor.handler.readCurrent(readContext())).rejects.toBeInstanceOf(
			ConfigReadFailedException
		);
	});

	it('returns only the fixed identity in identity mode without reading the row', async () => {
		const read = vi.spyOn(SettingsService.prototype, 'readSingleton');

		const result = await settingsDescriptor.handler.readCurrent(readContext('identity'));

		expect(result.records).toEqual([]);
		expect(result.documentIdentities).toEqual([{ key: 'project' }]);
		expect(read).not.toHaveBeenCalled();
	});
});

describe('settings applyUpdates', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('sends only the changed fields to upsertSingleton', async () => {
		const upsert = vi.spyOn(SettingsService.prototype, 'upsertSingleton').mockResolvedValue(1 as never);
		const context = applyContext();

		const outcome = await settingsDescriptor.handler.applyUpdates(
			[{ changes: { project_name: { before: 'Old', after: 'New' }, auth_login_attempts: { before: 5, after: null } } }],
			context
		);

		expect(upsert).toHaveBeenCalledWith({ project_name: 'New', auth_login_attempts: null }, context.mutationOptions);
		expect(outcome).toEqual({ op: 'update', updated: ['project'] });
	});

	it('does nothing for an empty update list', async () => {
		const upsert = vi.spyOn(SettingsService.prototype, 'upsertSingleton');

		const outcome = await settingsDescriptor.handler.applyUpdates([], applyContext());

		expect(upsert).not.toHaveBeenCalled();
		expect(outcome).toEqual({ op: 'update', updated: [] });
	});

	it('resolves a storage_default_folder key to a folder id before upserting', async () => {
		const upsert = vi.spyOn(SettingsService.prototype, 'upsertSingleton').mockResolvedValue(1 as never);
		const context = applyContext(new Map([['uploads', '00000000-0000-4000-8000-000000000001']]));

		await settingsDescriptor.handler.applyUpdates(
			[{ changes: { storage_default_folder: { before: null, after: 'uploads' } } }],
			context
		);

		expect(upsert).toHaveBeenCalledWith(
			{ storage_default_folder: '00000000-0000-4000-8000-000000000001' },
			context.mutationOptions
		);
	});

	it('clears storage_default_folder when the change sets it to null', async () => {
		const upsert = vi.spyOn(SettingsService.prototype, 'upsertSingleton').mockResolvedValue(1 as never);
		const context = applyContext();

		await settingsDescriptor.handler.applyUpdates(
			[{ changes: { storage_default_folder: { before: 'uploads', after: null } } }],
			context
		);

		expect(upsert).toHaveBeenCalledWith({ storage_default_folder: null }, context.mutationOptions);
	});
});

describe('settings singleton has no create or delete', () => {
	it('applyCreates is an asserting backstop', async () => {
		await expect(settingsDescriptor.handler.applyCreates([] as never, applyContext())).rejects.toThrow();
	});

	it('applyDeletes is an asserting backstop', async () => {
		await expect(settingsDescriptor.handler.applyDeletes([] as never, applyContext())).rejects.toThrow();
	});

	it('toCreateEntry throws', () => {
		expect(() => settingsDescriptor.toCreateEntry({} as never)).toThrow();
	});

	it('toDeleteEntry throws', () => {
		expect(() => settingsDescriptor.toDeleteEntry({ key: 'project' })).toThrow();
	});
});

describe('settings field validation through the shared record schema', () => {
	function rejects(record: Record<string, unknown>): void {
		expect(validateConfigRecord('settings', record).length).toBeGreaterThan(0);
	}

	function accepts(record: Record<string, unknown>): void {
		expect(validateConfigRecord('settings', record)).toEqual([]);
	}

	it('accepts a non-negative integer or null for auth_login_attempts', () => {
		accepts({ auth_login_attempts: 5 });
		accepts({ auth_login_attempts: null });
	});

	it('rejects a negative or non-integer auth_login_attempts', () => {
		rejects({ auth_login_attempts: -1 });
		rejects({ auth_login_attempts: 1.5 });
	});

	const STRUCTURED_ARRAY_FIELDS = ['module_bar', 'storage_asset_presets', 'basemaps', 'custom_aspect_ratios'] as const;

	it.each(STRUCTURED_ARRAY_FIELDS)('accepts a record array, an empty array, and null for %s', (field) => {
		accepts({ [field]: [{ key: 'a' }] });
		accepts({ [field]: [] });
		accepts({ [field]: null });
	});

	it.each(STRUCTURED_ARRAY_FIELDS)(
		'rejects a non-array, a null element, a scalar element, and a nested-array element for %s',
		(field) => {
			rejects({ [field]: 'not-an-array' });
			rejects({ [field]: [null] });
			rejects({ [field]: ['scalar'] });
			rejects({ [field]: [1] });
			rejects({ [field]: [true] });
			rejects({ [field]: [[]] });
		}
	);

	it('preserves element order, nested arrays, and unknown properties of valid records', () => {
		const record = {
			module_bar: [
				{ type: 'module', id: 'content', enabled: true },
				{ type: 'link', id: 'docs', url: 'https://example.test', icon: 'book', name: 'Docs', enabled: false },
			],
			storage_asset_presets: [{ key: 'thumb', transforms: [['blur', 5]], nested: { deep: [1, 2] } }],
		};

		const { error, value } = buildRecordSchemas('authored').settings.validate(record, {
			convert: false,
			abortEarly: false,
		});

		expect(error).toBeUndefined();
		expect(value).toEqual(record);
	});

	it('rejects a null array element in snapshot mode as well as authored mode', () => {
		const authored = validateConfigRecord('settings', { ...COMPLETE_RECORD, storage_asset_presets: [null] });

		const snapshot = validateConfigRecord(
			'settings',
			{ ...COMPLETE_RECORD, storage_asset_presets: [null] },
			'snapshot'
		);

		expect(authored.some((message) => message.includes('storage_asset_presets'))).toBe(true);
		expect(snapshot.some((message) => message.includes('storage_asset_presets'))).toBe(true);
	});

	it('rejects null for a non-nullable field and accepts it for a nullable one', () => {
		rejects({ project_name: null });
		accepts({ project_descriptor: null });
	});

	it('enforces the storage_asset_transform enum and rejects an empty string for it', () => {
		accepts({ storage_asset_transform: 'presets' });
		accepts({ storage_asset_transform: null });
		rejects({ storage_asset_transform: 'bogus' });
		rejects({ storage_asset_transform: '' });
	});

	it('accepts an empty string for a free-text field', () => {
		accepts({ custom_css: '' });
	});

	it('rejects a project_name longer than the stored column', () => {
		rejects({ project_name: 'x'.repeat(101) });
	});

	it('rejects an unknown top-level field', () => {
		rejects({ unknown_setting: true });
	});
});

describe('settings parseDocumentFile interpolation', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	function parse(record: Record<string, unknown>): ConfigSettings {
		return settingsDescriptor.layout.parseDocumentFile(record, 'project.yaml');
	}

	it('interpolates an in-namespace placeholder from the environment', () => {
		vi.stubEnv('CAIRNCMS_CONFIG_PROJECT_URL', 'https://resolved.example');

		expect(parse({ project_url: '{{CAIRNCMS_CONFIG_PROJECT_URL}}' }).project_url).toBe('https://resolved.example');
	});

	it('refuses an unset in-namespace variable', () => {
		vi.stubEnv('CAIRNCMS_CONFIG_PROJECT_URL', undefined);

		expect(() => parse({ project_url: '{{CAIRNCMS_CONFIG_PROJECT_URL}}' })).toThrow(
			ConfigPlaceholderUnresolvedException
		);
	});

	it('refuses an out-of-namespace variable', () => {
		expect(() => parse({ project_url: '{{OTHER_VAR}}' })).toThrow(ConfigInvalidException);
	});

	it('leaves a non-interpolatable field untouched', () => {
		expect(parse({ default_language: '{{CAIRNCMS_CONFIG_LANG}}' }).default_language).toBe('{{CAIRNCMS_CONFIG_LANG}}');
	});
});
