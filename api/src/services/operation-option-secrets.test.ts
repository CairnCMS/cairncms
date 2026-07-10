import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { encryptionKey } = vi.hoisted(() => ({
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

import { InvalidPayloadException } from '../exceptions/index.js';
import { decryptSecret, encryptSecret, hasSecretMarker, SECRET_MASK } from '../utils/encrypt-secret.js';
import {
	clearOperationOptionSecrets,
	decryptOperationOptions,
	encryptOperationOptionsForCreate,
	encryptOperationOptionsForUpdate,
	findUnencryptedSecretOptions,
	maskOperationOptions,
	registerOperationOptionSecrets,
} from './operation-option-secrets.js';

const KEY = Buffer.alloc(32, 5).toString('base64');
const TABLE = 'directus_operations';

class Client_PG extends MockClient {}

describe('operation-option-secrets', () => {
	let db: any;
	let tracker: Tracker;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: Client_PG }));
		tracker = createTracker(db);
		encryptionKey.value = KEY;
		clearOperationOptionSecrets();
		registerOperationOptionSecrets('secret-op', ['api_key']);
	});

	afterEach(() => {
		tracker.reset();
	});

	describe('the registry', () => {
		it('unions duplicate declarations for one type', async () => {
			registerOperationOptionSecrets('secret-op', ['other_key']);

			const payload: Record<string, unknown> = { type: 'secret-op', options: { api_key: 'a', other_key: 'b' } };
			await encryptOperationOptionsForCreate(payload);

			const options = payload['options'] as Record<string, unknown>;
			expect(hasSecretMarker(options['api_key'])).toBe(true);
			expect(hasSecretMarker(options['other_key'])).toBe(true);
		});
	});

	describe('encryptOperationOptionsForCreate', () => {
		it('encrypts a declared key to a marked envelope and leaves the rest', async () => {
			const payload: Record<string, unknown> = {
				type: 'secret-op',
				options: { api_key: 'sk_live_123', url: 'https://x' },
			};

			await encryptOperationOptionsForCreate(payload);

			const options = payload['options'] as Record<string, unknown>;
			expect(hasSecretMarker(options['api_key'])).toBe(true);
			expect(await decryptSecret(options['api_key'])).toBe('sk_live_123');
			expect(options['url']).toBe('https://x');
			expect(JSON.stringify(payload)).not.toContain('sk_live_123');
		});

		it('leaves an empty or null declared value as a clear', async () => {
			const payload: Record<string, unknown> = { type: 'secret-op', options: { api_key: '' } };
			await encryptOperationOptionsForCreate(payload);
			expect((payload['options'] as Record<string, unknown>)['api_key']).toBe('');

			const nulled: Record<string, unknown> = { type: 'secret-op', options: { api_key: null } };
			await encryptOperationOptionsForCreate(nulled);
			expect((nulled['options'] as Record<string, unknown>)['api_key']).toBeNull();
		});

		it('rejects a mask on create, there is no stored secret to preserve', async () => {
			const payload: Record<string, unknown> = { type: 'secret-op', options: { api_key: SECRET_MASK } };
			await expect(encryptOperationOptionsForCreate(payload)).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('rejects a non-string declared value', async () => {
			const payload: Record<string, unknown> = { type: 'secret-op', options: { api_key: { nested: true } } };
			await expect(encryptOperationOptionsForCreate(payload)).rejects.toBeInstanceOf(InvalidPayloadException);
		});

		it('encrypts a declared key on a custom-prototype options object', async () => {
			const options = Object.assign(Object.create({ inherited: true }), { api_key: 'sk_live_123' });
			const payload: Record<string, unknown> = { type: 'secret-op', options };

			await encryptOperationOptionsForCreate(payload);

			expect(hasSecretMarker((payload['options'] as Record<string, unknown>)['api_key'])).toBe(true);
		});

		it('leaves an undeclared type and a non-object options untouched', async () => {
			const payload: Record<string, unknown> = { type: 'core-request', options: { api_key: 'plain' } };
			await encryptOperationOptionsForCreate(payload);
			expect((payload['options'] as Record<string, unknown>)['api_key']).toBe('plain');

			const bare: Record<string, unknown> = { type: 'secret-op' };
			await encryptOperationOptionsForCreate(bare);
			expect(bare['options']).toBeUndefined();
		});
	});

	describe('encryptOperationOptionsForUpdate', () => {
		it('encrypts using the type from the stored row when the payload omits it', async () => {
			tracker.on.select(TABLE).response([{ id: 'op-1', type: 'secret-op', options: JSON.stringify({}) }]);

			const payload: Record<string, unknown> = { options: { api_key: 'sk_live_next' } };
			await encryptOperationOptionsForUpdate(db, ['op-1'], payload);

			const options = payload['options'] as Record<string, unknown>;
			expect(hasSecretMarker(options['api_key'])).toBe(true);
			expect(await decryptSecret(options['api_key'])).toBe('sk_live_next');
		});

		it('preserves the stored envelope when the payload carries the mask', async () => {
			const envelope = await encryptSecret('sk_live_stored');

			tracker.on
				.select(TABLE)
				.response([{ id: 'op-1', type: 'secret-op', options: JSON.stringify({ api_key: envelope }) }]);

			const payload: Record<string, unknown> = { options: { api_key: SECRET_MASK, url: 'https://x' } };
			await encryptOperationOptionsForUpdate(db, ['op-1'], payload);

			const options = payload['options'] as Record<string, unknown>;
			expect(await decryptSecret(options['api_key'])).toBe('sk_live_stored');
			expect(options['url']).toBe('https://x');
		});

		it('rejects a mask with no stored envelope behind it', async () => {
			tracker.on.select(TABLE).response([{ id: 'op-1', type: 'secret-op', options: JSON.stringify({}) }]);

			const payload: Record<string, unknown> = { options: { api_key: SECRET_MASK } };

			await expect(encryptOperationOptionsForUpdate(db, ['op-1'], payload)).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('rejects a multi-row update that touches a secret-declaring type', async () => {
			tracker.on.select(TABLE).response([
				{ id: 'op-1', type: 'secret-op', options: JSON.stringify({}) },
				{ id: 'op-2', type: 'secret-op', options: JSON.stringify({}) },
			]);

			const payload: Record<string, unknown> = { options: { api_key: 'sk_live_shared' } };

			await expect(encryptOperationOptionsForUpdate(db, ['op-1', 'op-2'], payload)).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('passes a multi-row update of non-declaring types through', async () => {
			tracker.on.select(TABLE).response([
				{ id: 'op-1', type: 'core-request', options: JSON.stringify({}) },
				{ id: 'op-2', type: 'core-mail', options: JSON.stringify({}) },
			]);

			const payload: Record<string, unknown> = { options: { subject: 'hello' } };
			await encryptOperationOptionsForUpdate(db, ['op-1', 'op-2'], payload);

			expect((payload['options'] as Record<string, unknown>)['subject']).toBe('hello');
		});

		it('encrypts by the payload type when the update also changes the type', async () => {
			tracker.on.select(TABLE).response([{ id: 'op-1', type: 'core-request', options: JSON.stringify({}) }]);

			const payload: Record<string, unknown> = { type: 'secret-op', options: { api_key: 'sk_live_retyped' } };
			await encryptOperationOptionsForUpdate(db, ['op-1'], payload);

			expect(hasSecretMarker((payload['options'] as Record<string, unknown>)['api_key'])).toBe(true);
		});

		it('rejects a type-only change that would reclassify stored plaintext as a declared secret', async () => {
			tracker.on
				.select(TABLE)
				.response([{ id: 'op-1', type: 'core-request', options: JSON.stringify({ api_key: 'sk_live_stored_clear' }) }]);

			const payload: Record<string, unknown> = { type: 'secret-op' };

			await expect(encryptOperationOptionsForUpdate(db, ['op-1'], payload)).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('allows a type-only change when the stored declared values are envelopes or empty', async () => {
			const envelope = await encryptSecret('sk_live_stored');

			tracker.on.select(TABLE).response([
				{ id: 'op-1', type: 'other-secret-op', options: JSON.stringify({ api_key: envelope }) },
				{ id: 'op-2', type: 'core-request', options: JSON.stringify({ api_key: '', url: 'https://x' }) },
			]);

			const payload: Record<string, unknown> = { type: 'secret-op' };
			await encryptOperationOptionsForUpdate(db, ['op-1', 'op-2'], payload);

			expect(payload['options']).toBeUndefined();
		});

		it('rejects a multi-row type-only change when any row holds offending plaintext', async () => {
			tracker.on.select(TABLE).response([
				{ id: 'op-1', type: 'core-request', options: JSON.stringify({}) },
				{ id: 'op-2', type: 'core-request', options: JSON.stringify({ api_key: 'sk_live_stored_clear' }) },
			]);

			const payload: Record<string, unknown> = { type: 'secret-op' };

			await expect(encryptOperationOptionsForUpdate(db, ['op-1', 'op-2'], payload)).rejects.toBeInstanceOf(
				InvalidPayloadException
			);
		});

		it('skips the read entirely for a type-only change to a non-declaring type', async () => {
			const payload: Record<string, unknown> = { type: 'core-mail' };
			await encryptOperationOptionsForUpdate(db, ['op-1'], payload);

			expect(tracker.history.select).toHaveLength(0);
		});
	});

	describe('maskOperationOptions', () => {
		it('masks a marked envelope without needing the type in the selection', async () => {
			const record: Record<string, unknown> = { options: { api_key: await encryptSecret('sk_live_123') } };
			maskOperationOptions(record);
			expect((record['options'] as Record<string, unknown>)['api_key']).toBe(SECRET_MASK);
		});

		it('masks a declared-key value when the type is present, marker or not', () => {
			const record: Record<string, unknown> = {
				type: 'secret-op',
				options: { api_key: 'written-before-the-declaration', url: 'https://x' },
			};

			maskOperationOptions(record);

			const options = record['options'] as Record<string, unknown>;
			expect(options['api_key']).toBe(SECRET_MASK);
			expect(options['url']).toBe('https://x');
		});

		it('masks a stale envelope of a type that is no longer declared', async () => {
			const record: Record<string, unknown> = {
				type: 'removed-op',
				options: { api_key: await encryptSecret('sk_live_stale') },
			};

			maskOperationOptions(record);
			expect((record['options'] as Record<string, unknown>)['api_key']).toBe(SECRET_MASK);
		});

		it('leaves non-secret options, empty values, and non-object options untouched', () => {
			const record: Record<string, unknown> = {
				type: 'core-request',
				options: { url: 'https://x', body: null, note: '' },
			};

			maskOperationOptions(record);

			expect(record['options']).toEqual({ url: 'https://x', body: null, note: '' });

			const bare: Record<string, unknown> = { type: 'secret-op', options: null };
			maskOperationOptions(bare);
			expect(bare['options']).toBeNull();
		});

		it('masks a declared key on a custom-prototype options object', () => {
			const options = Object.assign(Object.create({ inherited: true }), { api_key: 'sk_live_clear' });
			const record: Record<string, unknown> = { type: 'secret-op', options };

			maskOperationOptions(record);

			expect((record['options'] as Record<string, unknown>)['api_key']).toBe(SECRET_MASK);
		});
	});

	describe('findUnencryptedSecretOptions', () => {
		it('reports a declared key holding a present non-envelope value and nothing else', async () => {
			const options = {
				api_key: 'sk_live_stored_clear',
				url: 'https://x',
				empty: '',
			};

			expect(findUnencryptedSecretOptions('secret-op', options)).toEqual(['api_key']);
			expect(findUnencryptedSecretOptions('core-request', options)).toEqual([]);
			expect(findUnencryptedSecretOptions('secret-op', null)).toEqual([]);

			const enveloped = { api_key: await encryptSecret('sk_live_123') };
			expect(findUnencryptedSecretOptions('secret-op', enveloped)).toEqual([]);
		});
	});

	describe('decryptOperationOptions', () => {
		it('resolves a declared envelope to its cleartext in a copy', async () => {
			const stored = { api_key: await encryptSecret('sk_live_123'), url: 'https://x' };

			const resolved = await decryptOperationOptions(stored, ['api_key']);

			expect(resolved['api_key']).toBe('sk_live_123');
			expect(resolved['url']).toBe('https://x');
			expect(hasSecretMarker(stored.api_key)).toBe(true);
		});

		it('keeps a tampered envelope in place so the preparation fails closed downstream', async () => {
			const envelope: any = await encryptSecret('sk_live_123');
			const tampered = { ...envelope, ct: Buffer.from('tampered').toString('base64') };

			const resolved = await decryptOperationOptions({ api_key: tampered }, ['api_key']);

			expect(hasSecretMarker(resolved['api_key'])).toBe(true);
			expect(JSON.stringify(resolved)).not.toContain('sk_live_123');
		});

		it('fails a plaintext declared value closed, only an envelope functions as a secret', async () => {
			const resolved = await decryptOperationOptions({ api_key: 'written-before-the-declaration' }, ['api_key']);

			expect(typeof resolved['api_key']).not.toBe('string');
			expect(JSON.stringify(resolved)).not.toContain('written-before-the-declaration');
		});

		it('keeps an unsupported-kid envelope in place so the preparation fails closed', async () => {
			const envelope: any = await encryptSecret('sk_live_123');
			const orphaned = { ...envelope, kid: 'env:rotated' };

			const resolved = await decryptOperationOptions({ api_key: orphaned }, ['api_key']);

			expect(hasSecretMarker(resolved['api_key'])).toBe(true);
			expect(JSON.stringify(resolved)).not.toContain('sk_live_123');
		});

		it('keeps an envelope encrypted under changed key material in place, failing closed', async () => {
			const envelope = await encryptSecret('sk_live_123');
			encryptionKey.value = Buffer.alloc(32, 9).toString('base64');

			const resolved = await decryptOperationOptions({ api_key: envelope }, ['api_key']);

			expect(hasSecretMarker(resolved['api_key'])).toBe(true);
			expect(JSON.stringify(resolved)).not.toContain('sk_live_123');
		});

		it('passes an absent or empty declared value and a null options through unchanged', async () => {
			const resolved = await decryptOperationOptions({ api_key: '', url: 'https://x' }, ['api_key']);
			expect(resolved['api_key']).toBe('');
			expect(resolved['url']).toBe('https://x');

			expect(await decryptOperationOptions(null as any, ['api_key'])).toBeNull();
		});
	});
});
