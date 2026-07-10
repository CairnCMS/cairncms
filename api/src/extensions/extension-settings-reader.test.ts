import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredSettingRow } from '../services/extension-settings-store.js';
import { encryptSecret } from '../utils/encrypt-secret.js';
import { buildExtensionSettingsReader, EMPTY_EXTENSION_SETTINGS_READER } from './extension-settings-reader.js';

let factoryEnv: Record<string, unknown> = {};

vi.mock('../env.js', () => ({
	default: new Proxy({}, { get: (_target, prop) => factoryEnv[prop as string] }),
}));

const KEY = Buffer.alloc(32, 7).toString('base64');
const SUBJECT = 'cairncms-extension-reader';
const CONFIG_VAR = 'CAIRNCMS_EXT_READER_BILLING_KEY';

const declaration: any = {
	base_url: { type: 'string', scope: 'global' },
	retries: { type: 'number', scope: 'global' },
	api_key: { type: 'string', scope: 'global', secret: { source: 'inline' } },
	billing_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
	preview_url: { type: 'string', scope: 'collection' },
	channel_token: { type: 'string', scope: 'collection', secret: { source: 'inline' } },
};

function reader(overrides: {
	declaration?: any;
	globalRows?: StoredSettingRow[];
	collectionRows?: Record<string, StoredSettingRow[]>;
}) {
	return buildExtensionSettingsReader({
		subject: SUBJECT,
		getDeclaration: () => overrides.declaration,
		readGlobalRows: async () => overrides.globalRows ?? [],
		readCollectionRows: async (collection) => overrides.collectionRows?.[collection] ?? [],
	});
}

describe('buildExtensionSettingsReader', () => {
	beforeEach(() => {
		factoryEnv = { SECRETS_ENCRYPTION_KEY: KEY };
	});

	afterEach(() => {
		delete process.env[CONFIG_VAR];
	});

	it('returns a declared global non-secret value, normalizing a mixed-case key', async () => {
		const r = reader({ declaration, globalRows: [{ key: 'base_url', value: 'https://x' }] });

		expect(await r.get('base_url')).toBe('https://x');
		expect(await r.get('BASE_URL')).toBe('https://x');
	});

	it('returns null for a stored value that mismatches the declaration', async () => {
		const r = reader({ declaration, globalRows: [{ key: 'retries', value: 'three' }] });

		expect(await r.get('retries')).toBeNull();
	});

	it('decrypts an inline secret to its raw value', async () => {
		const r = reader({ declaration, globalRows: [{ key: 'api_key', value: await encryptSecret('sk_live_123') }] });

		expect(await r.get('api_key')).toBe('sk_live_123');
	});

	it('resolves a config secret from its derived raw environment variable, never touching the store', async () => {
		process.env[CONFIG_VAR] = '01234';

		const readGlobalRows = vi.fn(async () => {
			throw new Error('a config secret must not read the store');
		});

		const r = buildExtensionSettingsReader({
			subject: SUBJECT,
			getDeclaration: () => declaration,
			readGlobalRows,
			readCollectionRows: async () => [],
		});

		expect(await r.get('billing_key')).toBe('01234');
		expect(readGlobalRows).not.toHaveBeenCalled();
	});

	it('returns null for a config secret whose variable is unset', async () => {
		const r = reader({ declaration });

		expect(await r.get('billing_key')).toBeNull();
	});

	it('fails closed on a tampered or key-orphaned envelope', async () => {
		const envelope: any = await encryptSecret('sk_live_123');
		const tampered = { ...envelope, ct: Buffer.from('tampered').toString('base64') };

		expect(await reader({ declaration, globalRows: [{ key: 'api_key', value: tampered }] }).get('api_key')).toBeNull();

		const orphaned = await encryptSecret('sk_live_123');
		factoryEnv = { SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64') };

		expect(await reader({ declaration, globalRows: [{ key: 'api_key', value: orphaned }] }).get('api_key')).toBeNull();
	});

	it('returns null for an undeclared key, an empty key, and an absent owner', async () => {
		expect(await reader({ declaration }).get('nope')).toBeNull();
		expect(await reader({ declaration }).get('')).toBeNull();

		expect(
			await reader({ declaration: undefined, globalRows: [{ key: 'base_url', value: 'x' }] }).get('base_url')
		).toBeNull();
	});

	it('requires the explicit collection option for a collection-scoped key, both directions', async () => {
		const r = reader({
			declaration,
			globalRows: [{ key: 'base_url', value: 'https://x' }],
			collectionRows: { articles: [{ key: 'preview_url', value: 'https://p' }] },
		});

		expect(await r.get('preview_url')).toBeNull();
		expect(await r.get('preview_url', { scope: 'collection', collection: 'articles' })).toBe('https://p');
		expect(await r.get('base_url', { scope: 'collection', collection: 'articles' })).toBeNull();
	});

	it('reads a collection-scoped inline secret only under its collection', async () => {
		const envelope = await encryptSecret('sk_col_1');

		const r = reader({ declaration, collectionRows: { articles: [{ key: 'channel_token', value: envelope }] } });

		expect(await r.get('channel_token', { scope: 'collection', collection: 'articles' })).toBe('sk_col_1');
		expect(await r.get('channel_token', { scope: 'collection', collection: 'orders' })).toBeNull();
		expect(await r.get('channel_token')).toBeNull();
	});

	it('fails closed on a malformed options object instead of falling back to global', async () => {
		const r = reader({ declaration, globalRows: [{ key: 'base_url', value: 'https://x' }] });

		expect(await r.get('base_url', { scope: 'collections' } as any)).toBeNull();
		expect(await r.get('base_url', {} as any)).toBeNull();
		expect(await r.get('preview_url', { scope: 'collection', collection: '' } as any)).toBeNull();
	});

	it('the empty reader resolves every key null', async () => {
		expect(await EMPTY_EXTENSION_SETTINGS_READER.get('anything')).toBeNull();
	});
});
