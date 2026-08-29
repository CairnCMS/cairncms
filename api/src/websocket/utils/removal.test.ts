import type { SchemaOverview } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import type { RequestAccountability } from '../../utils/get-anonymous-accountability.js';
import type { WebSocketEvent } from '../messages.js';
import { deletableKeys, isDeleteFeedEligible, isDeleteFeedQueryAllowed } from './removal.js';

const SCHEMA = { collections: { articles: { primary: 'id' } } } as unknown as SchemaOverview;

function accountability(overrides: Record<string, unknown> = {}): RequestAccountability {
	return {
		user: 'u',
		role: 'r',
		admin: false,
		app: true,
		permissions: [],
		...overrides,
	} as unknown as RequestAccountability;
}

function readPermission(overrides: Record<string, unknown> = {}) {
	return { collection: 'articles', action: 'read', permissions: {}, fields: ['*'], ...overrides };
}

function deleteEvent(keys: (string | number)[]): Extract<WebSocketEvent, { action: 'delete' }> {
	return { action: 'delete', collection: 'articles', keys };
}

describe('isDeleteFeedEligible', () => {
	it('admits an admin', () => {
		expect(isDeleteFeedEligible('articles', accountability({ admin: true }), SCHEMA)).toBe(true);
	});

	it('admits an unconstrained read with wildcard fields', () => {
		expect(
			isDeleteFeedEligible('articles', accountability({ permissions: [readPermission({ fields: ['*'] })] }), SCHEMA)
		).toBe(true);
	});

	it('admits an unconstrained read that names the primary key', () => {
		expect(
			isDeleteFeedEligible('articles', accountability({ permissions: [readPermission({ fields: ['id'] })] }), SCHEMA)
		).toBe(true);
	});

	it('admits an unconstrained read with the legacy empty-fields form', () => {
		expect(
			isDeleteFeedEligible('articles', accountability({ permissions: [readPermission({ fields: [] })] }), SCHEMA)
		).toBe(true);
	});

	it('rejects a read that cannot see the primary key', () => {
		expect(
			isDeleteFeedEligible('articles', accountability({ permissions: [readPermission({ fields: ['title'] })] }), SCHEMA)
		).toBe(false);
	});

	it('rejects a constrained read', () => {
		const constrained = accountability({ permissions: [readPermission({ permissions: { tenant: { _eq: 'a' } } })] });
		expect(isDeleteFeedEligible('articles', constrained, SCHEMA)).toBe(false);
	});

	it('rejects a principal with no read permission for the collection', () => {
		expect(isDeleteFeedEligible('articles', accountability({ permissions: [] }), SCHEMA)).toBe(false);
	});

	it('rejects a collection absent from the schema', () => {
		expect(isDeleteFeedEligible('authors', accountability({ admin: true }), SCHEMA)).toBe(false);
	});

	it('rejects prototype-member names even for an admin', () => {
		for (const name of ['constructor', 'toString', '__proto__']) {
			expect(isDeleteFeedEligible(name, accountability({ admin: true }), SCHEMA)).toBe(false);
		}
	});
});

describe('isDeleteFeedQueryAllowed', () => {
	it('accepts an absent or empty query', () => {
		expect(isDeleteFeedQueryAllowed(undefined)).toBe(true);
		expect(isDeleteFeedQueryAllowed({})).toBe(true);
	});

	it('rejects any query clause', () => {
		expect(isDeleteFeedQueryAllowed({ filter: { status: { _eq: 'x' } } })).toBe(false);
		expect(isDeleteFeedQueryAllowed({ limit: 1 })).toBe(false);
		expect(isDeleteFeedQueryAllowed({ fields: ['id'] })).toBe(false);
	});
});

describe('deletableKeys', () => {
	it('returns all keys for a collection feed', () => {
		expect(deletableKeys(undefined, deleteEvent([1, 2]))).toEqual([1, 2]);
	});

	it('returns only the matching key for an exact-item feed, preserving type', () => {
		expect(deletableKeys('1', deleteEvent([1, 2]))).toEqual([1]);
		expect(deletableKeys('2', deleteEvent(['1', '2']))).toEqual(['2']);
	});

	it('returns nothing when the subscribed item is absent from the batch', () => {
		expect(deletableKeys('9', deleteEvent([1, 2]))).toEqual([]);
	});
});

describe('multi-tenant isolation', () => {
	it('gives a tenant-constrained principal nothing while an admin is eligible', () => {
		const tenant = accountability({ permissions: [readPermission({ permissions: { tenant: { _eq: 'a' } } })] });
		expect(isDeleteFeedEligible('articles', tenant, SCHEMA)).toBe(false);
		expect(isDeleteFeedEligible('articles', accountability({ admin: true }), SCHEMA)).toBe(true);
	});
});
