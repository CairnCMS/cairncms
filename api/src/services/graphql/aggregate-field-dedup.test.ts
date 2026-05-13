import type { Accountability, SchemaOverview } from '@cairncms/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

function field(name: string, innerSelections?: any[]): any {
	return {
		kind: 'Field',
		name: { kind: 'Name', value: name },
		selectionSet: innerSelections ? { kind: 'SelectionSet', selections: innerSelections } : undefined,
	};
}

function makeService() {
	return new GraphQLService({ accountability, schema, scope: 'system' });
}

describe('GraphQLService.getAggregateQuery — field deduplication (GHSA-7hmh-pfrp-vcx4)', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('inner duplication (advisory PoC shape)', () => {
		it('deduplicates repeated identical field selections within a single aggregate block', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [field('max', [field('id'), field('id'), field('id')])]);

			expect(result.aggregate).toEqual({ max: ['id'] });
		});

		it('deduplicates while preserving non-duplicate fields in declared order', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [
				field('max', [field('id'), field('id'), field('status')]),
			]);

			expect(result.aggregate).toEqual({ max: ['id', 'status'] });
		});
	});

	describe('outer duplication (merge contract)', () => {
		it('collapses repeated identical outer blocks (advisory PoC at small scale)', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [field('max', [field('id')]), field('max', [field('id')])]);

			expect(result.aggregate).toEqual({ max: ['id'] });
		});

		it('merges field names from repeated outer blocks with distinct inner fields', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [
				field('max', [field('id')]),
				field('max', [field('email')]),
			]);

			expect(result.aggregate).toEqual({ max: ['id', 'email'] });
		});

		it('merges partially-overlapping inner field lists across repeated outer blocks', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [
				field('max', [field('id'), field('email')]),
				field('max', [field('email'), field('status')]),
			]);

			expect(result.aggregate).toEqual({ max: ['id', 'email', 'status'] });
		});

		it('collapses combined outer-and-inner duplication (mini PoC)', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [
				field('max', [field('id'), field('id'), field('id')]),
				field('max', [field('id'), field('id'), field('id')]),
				field('max', [field('id'), field('id'), field('id')]),
			]);

			expect(result.aggregate).toEqual({ max: ['id'] });
		});
	});

	describe('regression guards', () => {
		it('passes a single-occurrence aggregate block through unchanged', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [field('max', [field('id')])]);

			expect(result.aggregate).toEqual({ max: ['id'] });
		});

		it('preserves multiple distinct fields in a single block in declared order', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [
				field('max', [field('id'), field('status'), field('email')]),
			]);

			expect(result.aggregate).toEqual({ max: ['id', 'status', 'email'] });
		});

		it('processes distinct aggregate operations independently', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [
				field('max', [field('id')]),
				field('min', [field('status')]),
			]);

			expect(result.aggregate).toEqual({ max: ['id'], min: ['status'] });
		});

		it('skips __typename pointers in inner selections', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [field('max', [field('id'), field('__typename')])]);

			expect(result.aggregate).toEqual({ max: ['id'] });
		});

		it('produces an empty array when the inner selection set is empty', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [field('max', [])]);

			expect(result.aggregate).toEqual({ max: [] });
		});
	});

	describe('boundary cases', () => {
		it('keeps same-name fields under distinct aggregate operations separate', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [field('max', [field('id')]), field('sum', [field('id')])]);

			expect(result.aggregate).toEqual({ max: ['id'], sum: ['id'] });
		});

		it('deduplicates the wildcard field within a count block', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [field('count', [field('*'), field('*'), field('*')])]);

			expect(result.aggregate).toEqual({ count: ['*'] });
		});

		it('deduplicates across repeated outer count blocks with the wildcard field', () => {
			const service = makeService();

			const result = (service as any).getAggregateQuery({}, [
				field('count', [field('*')]),
				field('count', [field('*')]),
			]);

			expect(result.aggregate).toEqual({ count: ['*'] });
		});
	});
});
