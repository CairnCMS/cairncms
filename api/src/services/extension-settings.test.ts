import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { manager, store, encryptionKey } = vi.hoisted(() => ({
	manager: { getSettingsOwner: vi.fn(), getDeclaredSettings: vi.fn() },
	store: { readGlobalSettings: vi.fn(), readCollectionSettings: vi.fn() },
	encryptionKey: { value: undefined as string | undefined },
}));

vi.mock('../env.js', async (importOriginal) => {
	const actual = (await importOriginal()) as { default: Record<string, unknown>; [key: string]: unknown };

	return {
		...actual,
		default: new Proxy(actual.default, {
			get: (target, prop) => (prop === 'SECRETS_ENCRYPTION_KEY' ? encryptionKey.value : target[prop as string]),
		}),
	};
});

vi.mock('../extensions.js', () => ({ getExtensionManager: () => manager }));

vi.mock('./extension-settings-store.js', () => ({
	readGlobalSettings: store.readGlobalSettings,
	readCollectionSettings: store.readCollectionSettings,
}));

import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { encryptSecret, SECRET_MASK } from '../utils/encrypt-secret.js';
import { ExtensionSettingsService } from './extension-settings.js';

const TABLE = 'cairncms_extension_settings';

class Client_PG extends MockClient {}

const KEY = Buffer.alloc(32, 7).toString('base64');

const admin = { role: 'admin', admin: true, user: 'admin-user', app: true } as any;
const schema = { collections: { articles: {} }, relations: [] } as any;

const declaration = {
	preview_url: { type: 'string', scope: 'collection' },
	count: { type: 'number', scope: 'global' },
	api_key: { type: 'string', scope: 'global', secret: { source: 'inline' } },
	billing_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
};

const owner = { name: 'cairncms-extension-preview', settings: declaration } as any;

describe('ExtensionSettingsService', () => {
	let db: any;
	let tracker: Tracker;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: Client_PG }));
		tracker = createTracker(db);
		encryptionKey.value = KEY;
		manager.getSettingsOwner.mockReset();
		manager.getDeclaredSettings.mockReset();
		manager.getDeclaredSettings.mockReturnValue([]);
		store.readGlobalSettings.mockReset();
		store.readCollectionSettings.mockReset();
	});

	afterEach(() => {
		tracker.reset();
	});

	const service = (accountability: any = admin) => new ExtensionSettingsService({ knex: db, schema, accountability });

	describe('set', () => {
		it('persists a valid value for an eligible owner', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);
			tracker.on.insert(TABLE).response([1]);

			await service().set('cairncms-extension-preview', 'collection', 'articles', 'preview_url', 'https://x');

			expect(tracker.history.insert).toHaveLength(1);
		});

		it('encrypts an inline secret to a marked envelope, never the plaintext', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);
			tracker.on.insert(TABLE).response([1]);

			await service().set('cairncms-extension-preview', 'global', '', 'api_key', 'sk_live_123');

			const bindings = tracker.history.insert[0]?.bindings ?? [];
			expect(bindings.some((b) => typeof b === 'string' && b.includes('cairncms-secret-envelope'))).toBe(true);
			expect(bindings.every((b) => typeof b !== 'string' || b.includes('sk_live_123') === false)).toBe(true);
		});

		it('refuses a non-admin', async () => {
			await expect(
				service({ admin: false }).set('cairncms-extension-preview', 'global', '', 'count', 1)
			).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('refuses an ineligible or absent subject', async () => {
			manager.getSettingsOwner.mockReturnValue(undefined);

			await expect(service().set('cairncms-extension-preview', 'global', '', 'count', 1)).rejects.toBeInstanceOf(
				ForbiddenException
			);
		});

		it('refuses an undeclared key', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(service().set('cairncms-extension-preview', 'global', '', 'nope', 1)).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('refuses an unknown scope', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(service().set('cairncms-extension-preview', 'tenant' as any, '', 'count', 1)).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('refuses a global scope with a non-empty scope key', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'global', 'articles', 'count', 1)
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('refuses a collection scope to a missing collection', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'collection', 'ghosts', 'preview_url', 'https://x')
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('refuses a prototype-chain scope key', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'collection', 'constructor', 'preview_url', 'https://x')
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('refuses a value stored under the wrong declared scope', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'global', '', 'preview_url', 'https://x')
			).rejects.toBeInstanceOf(InvalidPayloadException);

			await expect(
				service().set('cairncms-extension-preview', 'collection', 'articles', 'count', 1)
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('refuses a non-finite number', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(service().set('cairncms-extension-preview', 'global', '', 'count', NaN)).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('refuses an out-of-shape value', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'global', '', 'count', 'not-a-number')
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('refuses a non-string inline secret value', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'global', '', 'api_key', { was: 'an object' })
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('refuses writing the mask back to a secret', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'global', '', 'api_key', SECRET_MASK)
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('refuses any write to a config-sourced secret', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'global', '', 'billing_key', 'anything')
			).rejects.toBeInstanceOf(InvalidPayloadException);
		});
	});

	describe('get and deleteBySubject', () => {
		it('reads stored rows for any subject and parses the stored value', async () => {
			manager.getSettingsOwner.mockReturnValue(undefined);

			tracker.on.select(TABLE).response([
				{ scope: 'collection', scope_key: 'articles', key: 'preview_url', value: '"https://x"' },
				{ scope: 'global', scope_key: '', key: 'count', value: '42' },
			]);

			const rows = await service().get('cairncms-extension-preview');

			expect(rows).toEqual([
				{ scope: 'collection', scope_key: 'articles', key: 'preview_url', value: 'https://x' },
				{ scope: 'global', scope_key: '', key: 'count', value: 42 },
			]);
		});

		it('masks a declared-secret key and a marked envelope, leaving non-secrets in cleartext', async () => {
			manager.getDeclaredSettings.mockReturnValue([declaration]);
			const envelope = await encryptSecret('sk_live_123');

			tracker.on.select(TABLE).response([
				{ scope: 'global', scope_key: '', key: 'api_key', value: JSON.stringify(envelope) },
				{ scope: 'global', scope_key: '', key: 'count', value: '42' },
				{ scope: 'global', scope_key: '', key: 'orphan', value: JSON.stringify(envelope) },
			]);

			const rows = await service().get('cairncms-extension-preview');

			expect(rows).toEqual([
				{ scope: 'global', scope_key: '', key: 'api_key', value: SECRET_MASK },
				{ scope: 'global', scope_key: '', key: 'count', value: 42 },
				{ scope: 'global', scope_key: '', key: 'orphan', value: SECRET_MASK },
			]);
		});

		it('masks from the discovered declaration even when the owner is gated ineligible', async () => {
			manager.getSettingsOwner.mockReturnValue(undefined);
			manager.getDeclaredSettings.mockReturnValue([declaration]);

			tracker.on
				.select(TABLE)
				.response([{ scope: 'global', scope_key: '', key: 'api_key', value: '"sk_live_stored_clear"' }]);

			const rows = await service().get('cairncms-extension-preview');

			expect(rows).toEqual([{ scope: 'global', scope_key: '', key: 'api_key', value: SECRET_MASK }]);
		});

		it('deletes every row for a subject', async () => {
			tracker.on.delete(TABLE).response(3);

			expect(await service().deleteBySubject('cairncms-extension-preview')).toBe(3);
		});

		it('refuses a non-admin read and delete', async () => {
			await expect(service({ admin: false }).get('x')).rejects.toBeInstanceOf(ForbiddenException);
			await expect(service({ admin: false }).deleteBySubject('x')).rejects.toBeInstanceOf(ForbiddenException);
		});
	});

	describe('readForApp', () => {
		const appDeclaration = {
			theme: { type: 'string', scope: 'global', appReadable: true },
			internal_base: { type: 'string', scope: 'global' },
			api_key: { type: 'string', scope: 'global', secret: { source: 'inline' } },
			preview_url: { type: 'string', scope: 'collection', appReadable: true },
		};

		const appOwner = { name: 'cairncms-extension-preview', settings: appDeclaration } as any;

		it('returns only global app-readable values, omitting non-opted-in and secret keys', async () => {
			manager.getSettingsOwner.mockReturnValue(appOwner);

			store.readGlobalSettings.mockResolvedValue([
				{ key: 'theme', value: 'dark' },
				{ key: 'internal_base', value: 'https://internal' },
				{ key: 'api_key', value: 'sk_live_stored' },
			]);

			expect(await service(admin).readForApp('cairncms-extension-preview')).toEqual({ theme: 'dark' });
			expect(store.readGlobalSettings).toHaveBeenCalledWith(db, 'cairncms-extension-preview');
		});

		it('adds a collection-scoped value when the collection exists and the caller can read it', async () => {
			manager.getSettingsOwner.mockReturnValue(appOwner);
			store.readGlobalSettings.mockResolvedValue([{ key: 'theme', value: 'dark' }]);
			store.readCollectionSettings.mockResolvedValue([{ key: 'preview_url', value: 'https://x' }]);

			const editor = { user: 'u', app: true, permissions: [{ action: 'read', collection: 'articles' }] };

			expect(await service(editor).readForApp('cairncms-extension-preview', 'articles')).toEqual({
				theme: 'dark',
				preview_url: 'https://x',
			});

			expect(store.readGlobalSettings).toHaveBeenCalledWith(db, 'cairncms-extension-preview');
			expect(store.readCollectionSettings).toHaveBeenCalledWith(db, 'cairncms-extension-preview', 'articles');
		});

		it('omits the collection-scoped value when the caller cannot read the collection', async () => {
			manager.getSettingsOwner.mockReturnValue(appOwner);
			store.readGlobalSettings.mockResolvedValue([{ key: 'theme', value: 'dark' }]);

			const restricted = { user: 'u', app: true, permissions: [{ action: 'read', collection: 'other' }] };

			expect(await service(restricted).readForApp('cairncms-extension-preview', 'articles')).toEqual({ theme: 'dark' });
			expect(store.readCollectionSettings).not.toHaveBeenCalled();
		});

		it('denies collection-scoped values closed when the permission set is missing', async () => {
			manager.getSettingsOwner.mockReturnValue(appOwner);
			store.readGlobalSettings.mockResolvedValue([{ key: 'theme', value: 'dark' }]);

			expect(await service({ user: 'u', app: true }).readForApp('cairncms-extension-preview', 'articles')).toEqual({
				theme: 'dark',
			});

			expect(store.readCollectionSettings).not.toHaveBeenCalled();
		});

		it('omits a collection-scoped value when the collection no longer exists', async () => {
			manager.getSettingsOwner.mockReturnValue(appOwner);
			store.readGlobalSettings.mockResolvedValue([{ key: 'theme', value: 'dark' }]);

			expect(await service(admin).readForApp('cairncms-extension-preview', 'ghosts')).toEqual({ theme: 'dark' });
			expect(store.readCollectionSettings).not.toHaveBeenCalled();
		});

		it('omits a stored value whose shape no longer matches the declaration', async () => {
			manager.getSettingsOwner.mockReturnValue(appOwner);

			store.readGlobalSettings.mockResolvedValue([{ key: 'theme', value: { was: 'an object' } }]);

			expect(await service(admin).readForApp('cairncms-extension-preview')).toEqual({});
		});

		it('returns an empty object for an absent or ineligible subject', async () => {
			manager.getSettingsOwner.mockReturnValue(undefined);

			expect(await service(admin).readForApp('cairncms-extension-missing')).toEqual({});
		});

		it('refuses a read without accountability', async () => {
			await expect(service(null).readForApp('cairncms-extension-preview')).rejects.toBeInstanceOf(ForbiddenException);
		});

		it('refuses a caller without app access', async () => {
			await expect(service({ user: 'u', app: false }).readForApp('cairncms-extension-preview')).rejects.toBeInstanceOf(
				ForbiddenException
			);
		});
	});
});
