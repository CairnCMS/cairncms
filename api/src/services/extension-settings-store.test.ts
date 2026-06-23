import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGlobalSettings } from './extension-settings-store.js';

const TABLE = 'cairncms_extension_settings';

class Client_PG extends MockClient {}

describe('readGlobalSettings', () => {
	let db: any;
	let tracker: Tracker;

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: Client_PG }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
	});

	it('returns an empty array for a subject with no rows', async () => {
		tracker.on.select(TABLE).response([]);
		expect(await readGlobalSettings(db, 'cairncms-extension-x')).toEqual([]);
	});

	it('returns parsed scalar and pointer values', async () => {
		tracker.on.select(TABLE).response([
			{ key: 'base_url', value: '"https://x"' },
			{ key: 'api_key', value: '{"source":"config","name":"API_KEY"}' },
		]);

		expect(await readGlobalSettings(db, 'cairncms-extension-x')).toEqual([
			{ key: 'base_url', value: 'https://x' },
			{ key: 'api_key', value: { source: 'config', name: 'API_KEY' } },
		]);
	});

	it('omits a row whose stored value fails to parse', async () => {
		tracker.on.select(TABLE).response([
			{ key: 'good', value: '"ok"' },
			{ key: 'corrupt', value: 'not json{' },
		]);

		expect(await readGlobalSettings(db, 'cairncms-extension-x')).toEqual([{ key: 'good', value: 'ok' }]);
	});

	it('restricts the query to the global scope with an empty scope key', async () => {
		tracker.on.select(TABLE).response([{ key: 'base_url', value: '"g"' }]);

		await readGlobalSettings(db, 'cairncms-extension-x');

		expect(tracker.history.select[0]?.bindings).toEqual(['cairncms-extension-x', 'global', '']);
	});

	it('short-circuits an already-aborted signal without querying', async () => {
		const controller = new AbortController();
		controller.abort();

		expect(await readGlobalSettings(db, 'cairncms-extension-x', controller.signal)).toEqual([]);
		expect(tracker.history.select).toHaveLength(0);
	});
});
