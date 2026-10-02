import { inject } from 'vitest';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { withService } from './service';
import { createEnvironmentTest, apiFixtures, type EnvironmentOptions } from './environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';

export const redisImages = {
	redis6: 'redis@sha256:b362b5dff9d14d961dc3352db4776aba6a8c53ca2661d7c74ad2c121f82cdaea',
	redis7: 'redis@sha256:6ab0b6e7381779332f97b8ca76193e45b0756f38d4c0dcda72dbb3c32061ab99',
	redis60: 'redis@sha256:2b35fc7d2908e25aa6aa197f97882c8a67829d3b106ad5ea5c8028f816f26aa8',
};

export type RedisService = { url: string; client: Redis; namespace: string; available: () => boolean };

export async function withRedis(
	version: keyof typeof redisImages,
	directory: string,
	signal: AbortSignal,
	use: (redis: RedisService) => Promise<void>
) {
	await withService({ name: version, image: redisImages[version], port: 6379 }, directory, signal, async (service) => {
		const url = `redis://${service.host}:${service.port}/0`;

		const client = new Redis(url, {
			lazyConnect: true,
			connectTimeout: 5_000,
			commandTimeout: 5_000,
			retryStrategy: () => null,
			enableOfflineQueue: false,
		});

		try {
			await client.connect();
			if ((await client.ping()) !== 'PONG') throw new Error('Redis did not answer PING');
			await use({ url, client, namespace: `integration-${randomUUID()}`, available: service.available });
		} finally {
			client.disconnect();
		}
	});
}

export function createRedisTest(version: keyof typeof redisImages = 'redis6', options: EnvironmentOptions = {}) {
	return createEnvironmentTest()
		.extend<{
			redisState: Prerequisite<RedisService>;
			redis: RedisService;
			configurationState: Prerequisite<EnvironmentOptions>;
		}>({
			redisState: [
				async ({ cancellationSignal, teardownFailures }, use) => {
					await capturePrerequisite(
						(ready) => withRedis(version, inject('integration').directory, cancellationSignal, ready),
						use,
						teardownFailures
					);
				},
				{ scope: 'file' },
			],
			configurationState: [
				async ({ redisState }, use) => {
					if (!redisState.ok) return use(redisState);
					const redis = redisState.value;

					await use({
						ok: true,
						value: {
							...options,
							env: {
								...options.env,
								MESSENGER_STORE: 'redis',
								MESSENGER_REDIS: redis.url,
								MESSENGER_NAMESPACE: redis.namespace,
							},
						},
					});
				},
				{ scope: 'file' },
			],
			redis: async ({ redisState, task, skip }, use) => {
				const redis = requirePrerequisite(redisState, 'Redis', { task, skip });
				if (!redis.available()) throw new Error('Owned Redis service stopped');
				await use(redis);
			},
		})
		.extend(apiFixtures);
}
