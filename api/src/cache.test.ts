import { describe, expect, it, vi } from 'vitest';
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
