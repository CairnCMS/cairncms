import type { Accountability, SchemaOverview } from '@cairncms/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ServerService } from '../server.js';
import { GraphQLService } from './index.js';

vi.mock('../../database/index.js', () => ({
	default: vi.fn(),
	getDatabase: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

const accountability: Accountability = {
	user: null,
	role: null,
	admin: false,
	app: false,
	ip: '127.0.0.1',
};

const schema = { collections: {}, relations: [] } as unknown as SchemaOverview;

describe('GraphQLService — server_health memoization', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('runs ServerService.health() exactly once across concurrent parallel invocations', async () => {
		const healthSpy = vi.spyOn(ServerService.prototype, 'health').mockResolvedValue({ status: 'ok' });
		const service = new GraphQLService({ accountability, schema, scope: 'system' });

		const results = await Promise.all([
			(service as any).resolveServerHealth(),
			(service as any).resolveServerHealth(),
			(service as any).resolveServerHealth(),
			(service as any).resolveServerHealth(),
			(service as any).resolveServerHealth(),
		]);

		expect(healthSpy).toHaveBeenCalledOnce();
		expect(results).toHaveLength(5);

		for (const result of results) {
			expect(result).toEqual({ status: 'ok' });
		}
	});

	it('runs ServerService.health() exactly once on a single invocation (regression)', async () => {
		const healthSpy = vi.spyOn(ServerService.prototype, 'health').mockResolvedValue({ status: 'ok' });
		const service = new GraphQLService({ accountability, schema, scope: 'system' });

		const result = await (service as any).resolveServerHealth();

		expect(healthSpy).toHaveBeenCalledOnce();
		expect(result).toEqual({ status: 'ok' });
	});
});
