import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockInspector } = vi.hoisted(() => ({
	mockInspector: {
		overview: vi.fn(),
		tableInfo: vi.fn(),
		foreignKeys: vi.fn(),
	},
}));

vi.mock('@cairncms/schema', async (importOriginal) => ({
	...(await importOriginal<typeof import('@cairncms/schema')>()),
	createInspector: () => mockInspector,
}));

vi.mock('../../src/database/index', () => ({
	__esModule: true,
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

import { RelationsService } from './relations.js';

const admin = { role: 'admin', admin: true } as any;

const schema = {
	collections: {
		articles: { collection: 'articles', primary: 'id', fields: { id: {}, author: {}, bound: {} } },
		authors: { collection: 'authors', primary: 'id', fields: { id: {} } },
	},
	relations: [{ collection: 'articles', field: 'bound', related_collection: 'authors' }],
} as any;

describe('RelationsService schema-apply refusals', () => {
	let db: any;
	let tracker: Tracker;
	let writes: string[];

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
		writes = [];

		tracker.on.any(/insert into|update|delete from|alter table|create table/i).response((q) => {
			writes.push(q.sql);
			return [];
		});
	});

	afterEach(() => {
		tracker.reset();
	});

	function service() {
		return new RelationsService({ knex: db, schema, accountability: admin });
	}

	it('createOne refuses a relation without a collection and issues no write', async () => {
		await expect(service().createOne({ field: 'author' } as any)).rejects.toThrow('"collection" is required');

		expect(writes).toEqual([]);
	});

	it('createOne refuses a field that already has a relationship and issues no write', async () => {
		await expect(service().createOne({ collection: 'articles', field: 'bound' } as any)).rejects.toThrow(
			'already has an associated relationship'
		);

		expect(writes).toEqual([]);
	});

	it('updateOne refuses a field without a relationship and issues no write', async () => {
		await expect(service().updateOne('articles', 'author', {} as any)).rejects.toThrow(
			`Field "author" in collection "articles" doesn't have a relationship.`
		);

		expect(writes).toEqual([]);
	});

	it('deleteOne refuses a field without a relationship and issues no write', async () => {
		await expect(service().deleteOne('articles', 'author')).rejects.toThrow(
			`Field "author" in collection "articles" doesn't have a relationship.`
		);

		expect(writes).toEqual([]);
	});
});
