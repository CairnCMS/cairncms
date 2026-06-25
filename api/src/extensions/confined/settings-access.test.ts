import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettingRow } from '../../services/extension-settings-store.js';
import { buildConfinedSettingsAccess } from './settings-access.js';

const declaration: any = {
	base_url: { type: 'string', scope: 'global' },
	retries: { type: 'number', scope: 'global' },
	api_key: { type: 'string', scope: 'global', sensitive: true },
	preview_url: { type: 'string', scope: 'collection' },
};

const rows: StoredSettingRow[] = [
	{ key: 'base_url', value: 'https://x' },
	{ key: 'retries', value: 3 },
	{ key: 'api_key', value: { source: 'config', name: 'CAIRN_TEST_API_KEY' } },
];

const access = (rowsOverride: StoredSettingRow[] = rows) =>
	buildConfinedSettingsAccess({ declaration, readRows: async () => rowsOverride });

const live = () => new AbortController().signal;
const binding = (key: string) => ({ kind: 'extension-setting' as const, extensionId: 'e', contributionId: 'c', key });

describe('buildConfinedSettingsAccess', () => {
	afterEach(() => {
		delete process.env['CAIRN_TEST_API_KEY'];
	});

	it('exposes global keys only, lower-cased', () => {
		const { source } = access();
		expect(source.declared.map((d) => d.key).sort()).toEqual(['api_key', 'base_url', 'retries']);
		expect(source.declared.find((d) => d.key === 'api_key')?.sensitive).toBe(true);
	});

	it('returns a declared non-secret scalar, normalizing a mixed-case key', async () => {
		expect(await access().source.value('base_url', live())).toBe('https://x');
		expect(await access().source.value('retries', live())).toBe(3);
		expect(await access().source.value('BASE_URL', live())).toBe('https://x');
	});

	it('returns null for an undeclared or sensitive key', async () => {
		expect(await access().source.value('nope', live())).toBeNull();
		expect(await access().source.value('api_key', live())).toBeNull();
	});

	it('returns null for a stored value that mismatches the current declaration', async () => {
		expect(await access([{ key: 'retries', value: 'three' }]).source.value('retries', live())).toBeNull();

		expect(
			await access([{ key: 'base_url', value: { source: 'config', name: 'X' } }]).source.value('base_url', live())
		).toBeNull();

		expect(await access([{ key: 'retries', value: Infinity }]).source.value('retries', live())).toBeNull();
	});

	it('resolves a sensitive pointer to the raw env string', async () => {
		process.env['CAIRN_TEST_API_KEY'] = 'sk_live_123';
		const a = access();
		expect(await a.source.hasSecret('api_key', live())).toBe(true);
		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBe('sk_live_123');
	});

	it('hasSecret is false and resolve is null when the env var is unset', async () => {
		delete process.env['CAIRN_TEST_API_KEY'];
		const a = access();
		expect(await a.source.hasSecret('api_key', live())).toBe(false);
		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBeNull();
	});

	it('resolve fails closed for a non-sensitive, undeclared, or collection key', async () => {
		process.env['CAIRN_TEST_API_KEY'] = 'sk_live_123';
		const a = access();
		expect(await a.resolveExtensionSecret(binding('base_url'), live())).toBeNull();
		expect(await a.resolveExtensionSecret(binding('nope'), live())).toBeNull();
		expect(await a.resolveExtensionSecret(binding('preview_url'), live())).toBeNull();
	});

	it('resolve is null for a malformed pointer', async () => {
		process.env['CAIRN_TEST_API_KEY'] = 'sk_live_123';
		const a = access([{ key: 'api_key', value: { source: 'env', name: 'X' } }]);
		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBeNull();
	});

	it('does not read or cache on an aborted first call, so a later live read still works', async () => {
		const aborted = new AbortController();
		aborted.abort();
		const readRows = vi.fn(async (sig?: AbortSignal) => (sig?.aborted ? [] : rows));
		const a = buildConfinedSettingsAccess({ declaration, readRows });

		expect(await a.source.value('base_url', aborted.signal)).toBeNull();
		expect(readRows).not.toHaveBeenCalled();

		expect(await a.source.value('base_url', live())).toBe('https://x');
		expect(readRows).toHaveBeenCalledTimes(1);
	});
});
