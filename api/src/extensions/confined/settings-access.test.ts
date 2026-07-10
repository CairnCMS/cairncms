import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettingRow } from '../../services/extension-settings-store.js';
import { encryptSecret } from '../../utils/encrypt-secret.js';
import { buildConfinedSettingsAccess } from './settings-access.js';

let factoryEnv: Record<string, unknown> = {};

vi.mock('../../env.js', () => ({
	default: new Proxy({}, { get: (_target, prop) => factoryEnv[prop as string] }),
}));

const KEY = Buffer.alloc(32, 7).toString('base64');
const SUBJECT = 'cairncms-extension-test';
const CONFIG_VAR = 'CAIRNCMS_EXT_TEST_BILLING_KEY';

const declaration: any = {
	base_url: { type: 'string', scope: 'global' },
	retries: { type: 'number', scope: 'global' },
	api_key: { type: 'string', scope: 'global', secret: { source: 'inline' } },
	billing_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
	preview_url: { type: 'string', scope: 'collection' },
};

const access = (rowsOverride: StoredSettingRow[]) =>
	buildConfinedSettingsAccess({ subject: SUBJECT, declaration, readRows: async () => rowsOverride });

const live = () => new AbortController().signal;
const binding = (key: string) => ({ kind: 'extension-setting' as const, extensionId: 'e', contributionId: 'c', key });

describe('buildConfinedSettingsAccess', () => {
	let rows: StoredSettingRow[];

	beforeEach(async () => {
		factoryEnv = { SECRETS_ENCRYPTION_KEY: KEY };

		rows = [
			{ key: 'base_url', value: 'https://x' },
			{ key: 'retries', value: 3 },
			{ key: 'api_key', value: await encryptSecret('sk_live_123') },
		];
	});

	afterEach(() => {
		delete process.env[CONFIG_VAR];
	});

	it('exposes global keys only, lower-cased, and flags the secrets', () => {
		const { source } = access(rows);
		expect(source.declared.map((d) => d.key).sort()).toEqual(['api_key', 'base_url', 'billing_key', 'retries']);
		expect(source.declared.find((d) => d.key === 'api_key')?.isSecret).toBe(true);
		expect(source.declared.find((d) => d.key === 'billing_key')?.isSecret).toBe(true);
		expect(source.declared.find((d) => d.key === 'base_url')?.isSecret).toBe(false);
	});

	it('returns a declared non-secret scalar, normalizing a mixed-case key', async () => {
		expect(await access(rows).source.value('base_url', live())).toBe('https://x');
		expect(await access(rows).source.value('retries', live())).toBe(3);
		expect(await access(rows).source.value('BASE_URL', live())).toBe('https://x');
	});

	it('returns null for an undeclared or secret key', async () => {
		expect(await access(rows).source.value('nope', live())).toBeNull();
		expect(await access(rows).source.value('api_key', live())).toBeNull();
		expect(await access(rows).source.value('billing_key', live())).toBeNull();
	});

	it('returns null for a stored value that mismatches the current declaration', async () => {
		expect(await access([{ key: 'retries', value: 'three' }]).source.value('retries', live())).toBeNull();
		expect(await access([{ key: 'retries', value: Infinity }]).source.value('retries', live())).toBeNull();
	});

	it('decrypts an inline secret envelope to its plaintext', async () => {
		const a = access(rows);
		expect(await a.source.hasSecret('api_key', live())).toBe(true);
		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBe('sk_live_123');
	});

	it('resolves a config secret from its derived env variable, uncoerced', async () => {
		process.env[CONFIG_VAR] = '01234';
		const a = access(rows);
		expect(await a.source.hasSecret('billing_key', live())).toBe(true);
		expect(await a.resolveExtensionSecret(binding('billing_key'), live())).toBe('01234');
	});

	it('config secret is null when its env variable is unset', async () => {
		delete process.env[CONFIG_VAR];
		const a = access(rows);
		expect(await a.source.hasSecret('billing_key', live())).toBe(false);
		expect(await a.resolveExtensionSecret(binding('billing_key'), live())).toBeNull();
	});

	it('resolve fails closed for a non-secret, undeclared, or collection key', async () => {
		const a = access(rows);
		expect(await a.resolveExtensionSecret(binding('base_url'), live())).toBeNull();
		expect(await a.resolveExtensionSecret(binding('nope'), live())).toBeNull();
		expect(await a.resolveExtensionSecret(binding('preview_url'), live())).toBeNull();
	});

	it('inline resolve is null and never throws for a non-envelope stored value', async () => {
		const a = access([{ key: 'api_key', value: 'not-an-envelope' }]);
		expect(await a.source.hasSecret('api_key', live())).toBe(false);
		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBeNull();
	});

	it('inline resolve fails closed on a tampered envelope', async () => {
		const envelope: any = await encryptSecret('sk_live_123');
		const tampered = { ...envelope, ct: Buffer.from('tampered').toString('base64') };
		const a = access([{ key: 'api_key', value: tampered }]);
		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBeNull();
	});

	it('inline resolve fails closed on an envelope with an unsupported key id', async () => {
		const envelope: any = await encryptSecret('sk_live_123');
		const orphaned = { ...envelope, kid: 'env:rotated' };
		const a = access([{ key: 'api_key', value: orphaned }]);
		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBeNull();
	});

	it('inline resolve fails closed when the encryption key material has changed', async () => {
		const envelope = await encryptSecret('sk_live_123');
		const a = access([{ key: 'api_key', value: envelope }]);

		factoryEnv.SECRETS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

		expect(await a.resolveExtensionSecret(binding('api_key'), live())).toBeNull();
	});

	it('does not read or cache on an aborted first call, so a later live read still works', async () => {
		const aborted = new AbortController();
		aborted.abort();
		const readRows = vi.fn(async (sig?: AbortSignal) => (sig?.aborted ? [] : rows));
		const a = buildConfinedSettingsAccess({ subject: SUBJECT, declaration, readRows });

		expect(await a.source.value('base_url', aborted.signal)).toBeNull();
		expect(readRows).not.toHaveBeenCalled();

		expect(await a.source.value('base_url', live())).toBe('https://x');
		expect(readRows).toHaveBeenCalledTimes(1);
	});
});
