import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { manager } = vi.hoisted(() => ({ manager: { getSettingsOwner: vi.fn() } }));

vi.mock('../extensions.js', () => ({ getExtensionManager: () => manager }));

import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { ExtensionSettingsService } from './extension-settings.js';

const TABLE = 'cairncms_extension_settings';

class Client_PG extends MockClient {}

const admin = { role: 'admin', admin: true } as any;
const schema = { collections: { articles: {} }, relations: [] } as any;

const declaration = {
	preview_url: { type: 'string', scope: 'collection' },
	count: { type: 'number', scope: 'global' },
	api_key: { type: 'string', scope: 'global', sensitive: true },
};

const owner = { name: 'cairncms-extension-preview', settings: declaration } as any;

describe('ExtensionSettingsService', () => {
	let db: any;
	let tracker: Tracker;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: Client_PG }));
		tracker = createTracker(db);
		manager.getSettingsOwner.mockReset();
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

		it('accepts a sensitive secret pointer', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);
			tracker.on.insert(TABLE).response([1]);

			await service().set('cairncms-extension-preview', 'global', '', 'api_key', { source: 'config', name: 'API_KEY' });

			expect(tracker.history.insert).toHaveLength(1);
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

		it('refuses a sensitive value that is not a secret pointer', async () => {
			manager.getSettingsOwner.mockReturnValue(owner);

			await expect(
				service().set('cairncms-extension-preview', 'global', '', 'api_key', 'raw-secret')
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

		it('deletes every row for a subject', async () => {
			tracker.on.delete(TABLE).response(3);

			expect(await service().deleteBySubject('cairncms-extension-preview')).toBe(3);
		});

		it('refuses a non-admin read and delete', async () => {
			await expect(service({ admin: false }).get('x')).rejects.toBeInstanceOf(ForbiddenException);
			await expect(service({ admin: false }).deleteBySubject('x')).rejects.toBeInstanceOf(ForbiddenException);
		});
	});
});
