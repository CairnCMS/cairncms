import type { DeepPartial, Field, Type } from '@cairncms/types';
import { randomUUID } from 'crypto';
import { expect, vi } from 'vitest';
import { createApiTest, type Api } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createApiTest({
	env: { LOG_STYLE: 'raw', LOG_LEVEL: 'info' },
	hookFixtures: ['config-schema-accountability-probe'],
});

initializeFixtures();

type Document = Record<string, any>;

type SchemaFieldFixture = {
	collection: string;
	field: string;
	type: Type;
	meta: DeepPartial<Field['meta']> | null;
	schema: DeepPartial<NonNullable<Field['schema']>>;
};

type SchemaCollectionFixture = {
	collection: string;
	meta: null;
	schema: { name: string };
	fields: SchemaFieldFixture[];
	relations: unknown[];
};

type SchemaProbe = { event: string; hasAccountability: boolean; accountability: unknown };

function suffix(): string {
	return randomUUID().replace(/-/g, '').slice(0, 12);
}

async function snapshot(api: Api, resources: string[]): Promise<Document> {
	const response = await request(api.url)
		.get('/config/snapshot')
		.query({ manifest_version: '3', resources: resources.join(',') })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);
	return response.body.data;
}

function collectionWithMetaField(collection: string): SchemaCollectionFixture {
	return {
		collection,
		meta: null,
		schema: { name: collection },
		fields: [
			{
				collection,
				field: 'id',
				type: 'integer',
				meta: null,
				schema: {
					name: 'id',
					table: collection,
					data_type: 'integer',
					is_nullable: false,
					is_primary_key: true,
					has_auto_increment: true,
				},
			},
			{
				collection,
				field: 'title',
				type: 'string',
				meta: { interface: 'input' },
				schema: { name: 'title', table: collection, data_type: 'varchar' },
			},
		],
		relations: [],
	};
}

function fieldCreateProbes(logs: string, collection: string, field: string): SchemaProbe[] {
	const probes: SchemaProbe[] = [];

	for (const line of logs.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		try {
			const parsed = JSON.parse(trimmed);
			if (parsed?.wiredSchemaProbe !== true || parsed.event !== 'fields.create') continue;

			const metaText = JSON.stringify(parsed.meta ?? null);
			if (metaText.includes(collection) && metaText.includes(field)) probes.push(parsed);
		} catch {
			// not a structured record line
		}
	}

	return probes;
}

async function dropCollection(api: Api, collection: string): Promise<void> {
	const present =
		Boolean(await api.database('directus_collections').where({ collection }).first()) ||
		(await api.database.schema.hasTable(collection));

	if (present)
		await request(api.url).delete(`/collections/${collection}`).set('Authorization', `Bearer ${api.adminToken}`);

	await api.database('directus_fields').where({ collection }).delete();
}

test('runs the schema step events with no caller accountability', async ({ api }) => {
	const created = `schema_ctx_${suffix()}`;

	try {
		const desired = await snapshot(api, ['schema']);
		desired['schema'].push(collectionWithMetaField(created));

		const applied = await request(api.url)
			.post('/config/apply')
			.set('Authorization', `Bearer ${api.adminToken}`)
			.set('Content-Type', 'application/json')
			.send(desired);

		expect(applied.statusCode).toBe(200);
		expect(applied.body.meta.steps.schema).toBe('committed');

		const probes = await vi.waitFor(
			async () => {
				const found = fieldCreateProbes(await api.readLogs(), created, 'title');
				if (found.length === 0) throw new Error('fields.create probe not observed yet');
				return found;
			},
			{ timeout: 10_000, interval: 100 }
		);

		for (const probe of probes) {
			expect(probe.hasAccountability).toBe(true);
			expect(probe.accountability).toBeNull();
		}
	} finally {
		await dropCollection(api, created);
	}
});
