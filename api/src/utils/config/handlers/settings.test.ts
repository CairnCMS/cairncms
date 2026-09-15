import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import { SettingsService } from '../../../services/settings.js';
import type { ConfigSettings } from '../../../types/config.js';
import type { ApplyContext, ReadContext, ValidationContext } from '../descriptor.js';
import { validateConfigRecord } from '../../validate-desired-config.js';
import { settingsDescriptor, type SettingsKindTypes } from './settings.js';

const CONTEXT: ValidationContext = {
	rolesManaged: false,
	declaredRoleKeys: new Set<string>(),
	references: 'current-state',
	currentRoleKeys: new Set<string>(),
	currentFolderParents: new Map<string, string | null>(),
};

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
};

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { ...COMPLETE_ROW, ...overrides };
}

function without(source: Record<string, unknown>, key: string): Record<string, unknown> {
	const copy = { ...source };
	delete copy[key];
	return copy;
}

function readContext(readMode: 'full' | 'identity' = 'full'): ReadContext<SettingsKindTypes> {
	return {
		database: {} as Knex,
		schema: {} as SchemaOverview,
		readMode,
		dependency: (() => undefined) as never,
	};
}

function applyContext(): ApplyContext<SettingsKindTypes> {
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
		dependency: (() => undefined) as never,
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

	it('accepts an array, an empty array, and null for module_bar but rejects a non-array', () => {
		accepts({ module_bar: [{ id: 'nav' }] });
		accepts({ module_bar: [] });
		accepts({ module_bar: null });
		rejects({ module_bar: 'not-an-array' });
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
