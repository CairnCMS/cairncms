import type { SchemaOverview } from '@cairncms/types';
import Keyv from 'keyv';
import { deserialize } from 'node:v8';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSystemCache, getCache, getSchemaCache, setSchemaCache } from './cache.js';

vi.mock('./env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./env.js')>();

	const overrides: Record<string, unknown> = {
		CACHE_ENABLED: false,
		CACHE_STORE: 'memory',
		CACHE_NAMESPACE: 'schema-codec-test',
		CACHE_SYSTEM_TTL: '10m',
		MESSENGER_STORE: 'memory',
	};

	const proxy = new Proxy(actual.default, {
		get(target, prop) {
			return prop in overrides ? overrides[prop as string] : Reflect.get(target, prop);
		},
	});

	return { ...actual, default: proxy, getEnv: () => proxy };
});

function schema(): SchemaOverview {
	return {
		collections: {
			records: {
				collection: 'records',
				primary: 'id',
				singleton: false,
				sortField: null,
				accountability: 'all',
				note: ':base64:plain text - \u96ea',
				fields: {
					id: {
						field: 'id',
						defaultValue: null,
						nullable: false,
						generated: false,
						type: 'uuid',
						dbType: 'uuid',
						precision: null,
						scale: null,
						special: ['uuid'],
						note: null,
						validation: null,
						alias: false,
					},
					metadata: {
						field: 'metadata',
						defaultValue: { prefix: ':value', values: [null, false, 3] },
						nullable: true,
						generated: false,
						type: 'json',
						dbType: 'jsonb',
						precision: null,
						scale: null,
						special: ['cast-json'],
						note: 'null is permitted',
						validation: { _and: [{ metadata: { _nnull: true } }] },
						alias: false,
					},
				},
			},
		},
		relations: [],
	};
}

describe('schema snapshot contracts', () => {
	beforeEach(async () => {
		await clearSystemCache({ forced: true });
	});

	afterEach(() => vi.restoreAllMocks());

	it('stores the local snapshot as V8 data and reads it through the cache', async () => {
		const value = schema();
		await setSchemaCache(value);
		const { localSchemaCache } = getCache();
		const stored = await localSchemaCache.opts.store!.get(`${localSchemaCache.opts.namespace}:schema`);

		expect(typeof stored).toBe('string');
		const snapshot = deserialize(Buffer.from(stored!, 'base64'));
		expect(snapshot.value).toStrictEqual(value);
		expect(snapshot.expires).toEqual(expect.any(Number));
		expect(await getSchemaCache()).toStrictEqual(value);
	});

	it('normalizes metadata as the established codec', async () => {
		const value = schema();
		const reference = new Keyv();
		await reference.set('schema', value);
		await setSchemaCache(value);
		expect(await getSchemaCache()).toStrictEqual(await reference.get('schema'));
	});

	it('owns the input snapshot and detaches concurrent readers', async () => {
		const value = schema();
		await setSchemaCache(value);
		value.collections['records']!.fields['metadata']!.defaultValue.values.push('input');
		const [first, second] = await Promise.all([getSchemaCache(), getSchemaCache()]);
		expect(first).toStrictEqual(schema());
		first!.collections['records']!.fields['metadata']!.special.push('conceal');
		first!.collections['records']!.fields['metadata']!.defaultValue.values.push('reader');
		expect(second).toStrictEqual(schema());
		expect(await getSchemaCache()).toStrictEqual(schema());
	});

	it('requires the current shared hash and retains earlier readers after replacement', async () => {
		await setSchemaCache(schema());
		const previous = await getSchemaCache();
		await getCache().sharedSchemaCache.set('hash', 'different');
		expect(await getSchemaCache()).toBeUndefined();
		await setSchemaCache(schema());
		await getCache().sharedSchemaCache.delete('hash');
		expect(await getSchemaCache()).toBeUndefined();
		const changed = schema();
		changed.collections['records']!.note = 'changed';
		await setSchemaCache(changed);
		expect(await getSchemaCache()).toStrictEqual(changed);
		expect(previous).toStrictEqual(schema());
	});

	it('expires locally even when the shared hash has a longer lifetime', async () => {
		const now = Date.now();
		const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
		await setSchemaCache(schema());
		const hash = await getCache().sharedSchemaCache.get('hash');
		await getCache().sharedSchemaCache.set('hash', hash, 1200000);
		clock.mockReturnValue(now + 600000);
		expect(await getSchemaCache()).toStrictEqual(schema());
		clock.mockReturnValue(now + 600001);
		expect(await getSchemaCache()).toBeUndefined();
		expect(await getCache().sharedSchemaCache.get('hash')).toBe(hash);
	});

	it('invalidates a lookup waiting for shared-store I/O', async () => {
		await setSchemaCache(schema());
		const shared = getCache().sharedSchemaCache;
		const hash = await shared.get('hash');
		let release!: () => void;

		const waiting = new Promise<void>((resolve) => {
			release = resolve;
		});

		vi.spyOn(shared, 'get').mockImplementationOnce(async () => {
			await waiting;
			return hash;
		});

		const pending = getSchemaCache();
		await clearSystemCache({ forced: true });
		release();
		expect(await pending).toBeUndefined();
		expect(await getSchemaCache()).toBeUndefined();
	});

	it('does not serve an obsolete fill whose shared publication was overtaken', async () => {
		const shared = getCache().sharedSchemaCache;
		const original = shared.set.bind(shared);
		let release!: () => void;
		let published!: () => void;

		const reached = new Promise<void>((resolve) => {
			published = resolve;
		});

		vi.spyOn(shared, 'set').mockImplementationOnce(async (...args) => {
			await original(...args);
			published();

			await new Promise<void>((resolve) => {
				release = resolve;
			});

			return true;
		});

		const pending = setSchemaCache(schema());
		await reached;
		const changed = schema();
		changed.collections['records']!.note = 'current';
		await setSchemaCache(changed);
		release();
		await pending;
		expect(await getSchemaCache()).toBeUndefined();
	});

	it('preserves codec edge values without modifying prototypes', async () => {
		const reference = new Keyv();
		const value = schema();

		value.collections['records']!.fields['metadata']!.defaultValue = {
			bytes: Buffer.from([0, 1, 255]),
			date: new Date('2026-01-01T00:00:00Z'),
			prefixes: [':base64:literal', ':', '::'],
			numbers: [NaN, Infinity, -0],
			array: [undefined, null],
			omitted: undefined,
			ownKeys: JSON.parse('{"__proto__":{"sentinel":true},"constructor":"ordinary"}'),
		};

		await reference.set('schema', value);
		await setSchemaCache(value);
		expect(await getSchemaCache()).toStrictEqual(await reference.get('schema'));
		expect(Object.prototype).not.toHaveProperty('sentinel');
	});

	it('propagates shared-store errors and preserves sibling codecs', async () => {
		await setSchemaCache(schema());
		const reference = new Keyv();
		const { sharedSchemaCache, systemCache } = getCache();
		expect(sharedSchemaCache.opts.serialize).toBe(reference.opts.serialize);
		expect(systemCache.opts.deserialize).toBe(reference.opts.deserialize);
		vi.spyOn(sharedSchemaCache, 'get').mockRejectedValueOnce(new Error('unavailable'));
		await expect(getSchemaCache()).rejects.toThrow('unavailable');
		expect(await getSchemaCache()).toStrictEqual(schema());
	});
});
