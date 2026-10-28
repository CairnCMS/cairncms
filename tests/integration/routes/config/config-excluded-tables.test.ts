import { randomUUID } from 'crypto';
import { describe, expect } from 'vitest';
import { apiTest as test, type Api } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { CreateCollection } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const EXCLUDED = 'sysdiagrams';

initializeFixtures();

type Document = Record<string, any>;
type Change = { kind: string; operation: string; identity: Record<string, string> };

async function snapshotSchema(api: Api): Promise<Document> {
	const response = await request(api.url)
		.get('/config/snapshot')
		.query({ manifest_version: '3', resources: 'schema' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
	return response.body.data;
}

function applyConfig(api: Api, desired: Document, query: Record<string, string>) {
	return request(api.url)
		.post('/config/apply')
		.query(query)
		.set('Authorization', `Bearer ${api.adminToken}`)
		.set('Content-Type', 'application/json')
		.send(desired);
}

describe('config-as-code leaves a table in DB_EXCLUDE_TABLES alone', () => {
	test('keeps the excluded table out of snapshots and out of a schema-managed apply that drops a collection', async ({
		api,
	}) => {
		const control = `excluded_control_${randomUUID().replace(/-/g, '').slice(0, 8)}`;

		try {
			await api.database.schema.createTable(EXCLUDED, (table) => {
				table.increments('id').primary();
				table.string('entry');
			});

			await api.database(EXCLUDED).insert({ entry: 'kept' });
			await CreateCollection(api, { collection: control });

			const captured = await snapshotSchema(api);
			const captureNames = (captured['schema'] as Document[]).map((record) => record['collection']);

			expect(captureNames).toContain(control);
			expect(captureNames).not.toContain(EXCLUDED);
			expect(captureNames).not.toContain('spatial_ref_sys');

			const desired = {
				...captured,
				schema: (captured['schema'] as Document[]).filter((record) => record['collection'] !== control),
			};

			const preview = await applyConfig(api, desired, { dry_run: 'true' });
			expect(preview.statusCode).toBe(200);

			const touched = (preview.body.data.changes as Change[])
				.filter((change) => ['collections', 'fields', 'relations'].includes(change.kind))
				.map((change) => `${change.operation} ${change.identity['collection']}`);

			expect(touched).toContain(`delete ${control}`);
			expect(touched.some((entry) => entry.endsWith(` ${EXCLUDED}`))).toBe(false);

			const applied = await applyConfig(api, desired, { destructive: 'true' });
			expect(applied.statusCode).toBe(200);
			expect(applied.body.meta.steps.schema).toBe('committed');

			expect(await api.database.schema.hasTable(control)).toBe(false);
			expect(await api.database(EXCLUDED).select('entry')).toEqual([{ entry: 'kept' }]);
		} finally {
			await request(api.url).delete(`/collections/${control}`).set('Authorization', `Bearer ${api.adminToken}`);
			await api.database.schema.dropTableIfExists(control);
			await api.database.schema.dropTableIfExists(EXCLUDED);
		}
	});
});
