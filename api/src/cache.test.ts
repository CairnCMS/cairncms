import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSystemCache, getCache, setSchemaCache } from './cache.js';

vi.mock('./env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./env.js')>();

	const overrides: Record<string, unknown> = {
		CACHE_ENABLED: false,
		CACHE_STORE: 'memory',
		CACHE_NAMESPACE: 'cache-test',
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

describe('clearSystemCache', () => {
	it('removes the shared schema hash', async () => {
		await setSchemaCache({ collections: {}, relations: [] } as any);
		expect(await getCache().sharedSchemaCache.get('hash')).toBeDefined();

		await clearSystemCache();

		expect(await getCache().sharedSchemaCache.get('hash')).toBeUndefined();
	});
});

describe('clearSystemCache lock handling', () => {
	beforeEach(async () => {
		const { systemCache, lockCache } = getCache();
		await systemCache.clear();
		await lockCache.delete('system-cache-lock');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('forces a clear while a skip-path caller leaves stale data in place', async () => {
		const { systemCache, lockCache } = getCache();

		await systemCache.set('stale', 'value');
		await lockCache.set('system-cache-lock', true, 10000);

		await clearSystemCache();
		expect(await systemCache.get('stale')).toBe('value');

		await clearSystemCache({ forced: true });
		expect(await systemCache.get('stale')).toBeUndefined();
	});

	it('releases the lock when the system cache clear fails', async () => {
		const { systemCache, lockCache } = getCache();

		await systemCache.set('stale', 'value');

		vi.spyOn(systemCache, 'clear').mockRejectedValueOnce(new Error('cache unavailable'));

		await expect(clearSystemCache({ forced: true })).rejects.toThrow('cache unavailable');
		expect(await lockCache.get('system-cache-lock')).toBeUndefined();

		await clearSystemCache();
		expect(await systemCache.get('stale')).toBeUndefined();
	});

	it('keeps the cache cleared when an overlapping clearer fails after a forced flush', async () => {
		const { systemCache } = getCache();
		const originalClear = systemCache.clear.bind(systemCache);

		await systemCache.set('stale', 'value');

		let failHolder: () => void = () => undefined;

		const holderClear = new Promise<void>((_, reject) => {
			failHolder = () => reject(new Error('cache unavailable'));
		});

		let holderReachedClear: () => void = () => undefined;

		const holderInClear = new Promise<void>((resolve) => {
			holderReachedClear = resolve;
		});

		vi.spyOn(systemCache, 'clear')
			.mockImplementationOnce(() => {
				holderReachedClear();
				return holderClear;
			})
			.mockImplementation(() => originalClear());

		// a concurrent clearer takes the lock and begins clearing, then stalls
		const holder = clearSystemCache();
		await holderInClear;

		// a skip-path caller sees the held lock and leaves the stale data in place
		await clearSystemCache();
		expect(await systemCache.get('stale')).toBe('value');

		// the forced route clears regardless of the held lock
		await clearSystemCache({ forced: true });
		expect(await systemCache.get('stale')).toBeUndefined();

		// the stalled clearer now fails, and the cache stays cleared
		failHolder();
		await expect(holder).rejects.toThrow('cache unavailable');
		expect(await systemCache.get('stale')).toBeUndefined();
	});
});
