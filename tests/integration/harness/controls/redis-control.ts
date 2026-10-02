import { expect } from 'vitest';
import { createRedisTest } from '../../fixtures/redis';
import request from '../../fixtures/request';

export function redisControl(version: 'redis6' | 'redis7' | 'redis60') {
	const test = createRedisTest(version);
	const expected = { redis6: /redis_version:6\.2\./, redis7: /redis_version:7\./, redis60: /redis_version:6\.0\./ };

	test(`${version} is owned and its messenger configuration reaches a real API`, async ({ redis, api }) => {
		expect(await redis.client.info('server')).toMatch(expected[version]);
		await redis.client.set(`${redis.namespace}:probe`, version);
		expect(await redis.client.get(`${redis.namespace}:probe`)).toBe(version);
		const health = await request(api.url).get('/server/health').auth(api.adminToken, { type: 'bearer' }).expect(200);
		expect(health.body.checks['messenger:status'][0].status).toBe('ok');
		const companion = await api.start();
		await request(companion.url).get('/server/health').auth(api.adminToken, { type: 'bearer' }).expect(200);
	});
}
