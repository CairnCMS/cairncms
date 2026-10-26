import { randomUUID } from 'crypto';
import { createInspector } from '@cairncms/schema';
import { expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { describeForVendors } from '../../fixtures/applicability';
import { USER } from '../../fixtures/identities';
import request, { setupRequest } from '../../fixtures/request';
import { createScenarioTest } from '../../fixtures/scenario';
import { familyOf, hasCapability, vendorsWith } from '../../harness/database-vendors.mjs';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const STORED = 'test_fields_generated_stored';
const VIRTUAL = 'test_fields_generated_virtual';

type Fixture = {
	table: string;
	generated: Record<string, 'product' | 'sum'>;
	ordinary: string[];
};

const storedFixture: Fixture = {
	table: STORED,
	generated: { total_stored: 'product' },
	ordinary: ['id', 'price', 'qty', 'plain'],
};

const virtualFixture: Fixture = {
	table: VIRTUAL,
	generated: { total_virtual: 'product', total_default_kind: 'sum' },
	ordinary: ['id', 'price', 'qty', 'plain'],
};

async function createTable(api: Api, table: string, generatedColumns: string) {
	await api.database.raw(
		`create table ?? (id integer primary key, price integer, qty integer, plain integer default 5, ${generatedColumns})`,
		[table]
	);

	await api.database(table).insert({ id: 1, price: 3, qty: 4 });

	await setupRequest(api.url)
		.patch(`/collections/${table}`)
		.auth(api.adminToken, { type: 'bearer' })
		.send({ meta: {} })
		.expect(200);

	await setupRequest(api.url)
		.patch(`/fields/${table}/price`)
		.auth(api.adminToken, { type: 'bearer' })
		.send({ meta: { note: 'initial' } })
		.expect(200);
}

const test = createScenarioTest({
	environment: { env: { CACHE_SCHEMA: 'false' } },
	prepare: async (api, vendor) => {
		if (hasCapability(vendor, 'generated-columns'))
			await createTable(api, STORED, 'total_stored integer generated always as (price * qty) stored');

		if (hasCapability(vendor, 'virtual-generated-columns'))
			await createTable(
				api,
				VIRTUAL,
				'total_virtual integer generated always as (price * qty) virtual, total_default_kind integer generated always as (price + qty)'
			);
	},
	cleanup: async () => {
		/* The owned database is dropped after the API exits. */
	},
});

function expression(vendor: string, kind: 'product' | 'sum') {
	const operator = kind === 'product' ? '*' : '+';

	switch (familyOf(vendor)) {
		case 'postgres':
			return `(price ${operator} qty)`;
		case 'mysql':
			return `(\`price\` ${operator} \`qty\`)`;
		case 'maria':
			return `\`price\` ${operator} \`qty\``;
		default:
			return null;
	}
}

async function fieldSchemas(api: Api, table: string) {
	const response = await request(api.url).get(`/fields/${table}`).auth(api.adminToken, { type: 'bearer' });
	expect(response.statusCode).toBe(200);

	return Object.fromEntries(
		response.body.data.map((field: { field: string; schema: Record<string, unknown> }) => [field.field, field.schema])
	);
}

async function generatedState(api: Api, fixture: Fixture) {
	const schemas = await fieldSchemas(api, fixture.table);

	return {
		classification: Object.fromEntries(
			Object.keys(fixture.generated).map((column) => [
				column,
				{ is_generated: schemas[column].is_generated, generation_expression: schemas[column].generation_expression },
			])
		),
		row: await api.database(fixture.table).where({ id: 1 }).first(),
	};
}

async function snapshot(api: Api) {
	const response = await request(api.url).get('/schema/snapshot').auth(api.adminToken, { type: 'bearer' });
	expect(response.statusCode).toBe(200);
	return response.body.data;
}

async function diff(api: Api, desired: unknown) {
	return request(api.url)
		.post('/schema/diff')
		.auth(api.adminToken, { type: 'bearer' })
		.send(desired as object)
		.set('Content-type', 'application/json');
}

async function apply(api: Api, plan: unknown) {
	return request(api.url)
		.post('/schema/apply')
		.auth(api.adminToken, { type: 'bearer' })
		.send(plan as object)
		.set('Content-type', 'application/json');
}

function expectComputed(fixture: Fixture, row: Record<string, number>) {
	for (const [column, kind] of Object.entries(fixture.generated))
		expect(Number(row[column]), column).toBe(
			kind === 'product' ? row['price']! * row['qty']! : row['price']! + row['qty']!
		);
}

function coverage(fixture: Fixture) {
	test('the inspector overview and column detail agree on every column', async ({ api }) => {
		const inspector = createInspector(api.database);
		const overview = await inspector.overview();
		const columns = await inspector.columnInfo(fixture.table);

		for (const column of columns) {
			const expected = column.name in fixture.generated;
			expect(column.is_generated, `columnInfo ${column.name}`).toBe(expected);
			expect(overview[fixture.table]!.columns[column.name]!.is_generated, `overview ${column.name}`).toBe(expected);
		}
	});

	test('the fields endpoint reports generated and ordinary columns', async ({ api, vendor }) => {
		const schemas = await fieldSchemas(api, fixture.table);

		for (const [column, kind] of Object.entries(fixture.generated)) {
			expect(schemas[column], column).toMatchObject({
				is_generated: true,
				generation_expression: expression(vendor, kind),
				default_value: null,
			});

			const single = await request(api.url)
				.get(`/fields/${fixture.table}/${column}`)
				.auth(api.adminToken, { type: 'bearer' });

			expect(single.statusCode).toBe(200);
			expect(single.body.data.schema).toEqual(schemas[column]);
		}

		for (const column of fixture.ordinary)
			expect(schemas[column], column).toMatchObject({ is_generated: false, generation_expression: null });

		expect(Number(schemas['plain'].default_value)).toBe(5);
	});

	test('the schema snapshot records the same classification', async ({ api }) => {
		const schemas = await fieldSchemas(api, fixture.table);

		const fields = (await snapshot(api)).fields.filter(
			(field: { collection: string }) => field.collection === fixture.table
		);

		for (const column of [...Object.keys(fixture.generated), ...fixture.ordinary]) {
			const entry = fields.find((field: { field: string }) => field.field === column);

			expect(entry?.schema, column).toMatchObject({
				is_generated: schemas[column].is_generated,
				generation_expression: schemas[column].generation_expression,
			});
		}
	});

	test('a metadata-only schema apply persists the note and preserves generated columns', async ({ api }) => {
		const before = await generatedState(api, fixture);
		const desired = await snapshot(api);
		const note = `note ${randomUUID()}`;

		desired.fields.find(
			(field: { collection: string; field: string }) => field.collection === fixture.table && field.field === 'price'
		).meta.note = note;

		const planned = await diff(api, desired);
		expect(planned.statusCode).toBe(200);
		expect(planned.body.data.diff.collections).toEqual([]);
		expect(planned.body.data.diff.relations).toEqual([]);

		expect(planned.body.data.diff.fields).toEqual([
			{
				collection: fixture.table,
				field: 'price',
				diff: [expect.objectContaining({ kind: 'E', path: ['meta', 'note'], rhs: note })],
			},
		]);

		expect((await apply(api, planned.body.data)).statusCode).toBe(204);

		const price = await request(api.url).get(`/fields/${fixture.table}/price`).auth(api.adminToken, { type: 'bearer' });
		expect(price.statusCode).toBe(200);
		expect(price.body.data.meta.note).toBe(note);
		expect(await generatedState(api, fixture)).toEqual(before);
	});

	test('item writes recompute generated values and generated columns reject writes', async ({ api }) => {
		const read = await request(api.url).get(`/items/${fixture.table}/1`).auth(api.adminToken, { type: 'bearer' });
		expect(read.statusCode).toBe(200);
		expectComputed(fixture, read.body.data);

		const price = Number(read.body.data.price) + 1;

		const updated = await request(api.url)
			.patch(`/items/${fixture.table}/1`)
			.auth(api.adminToken, { type: 'bearer' })
			.send({ price });

		expect(updated.statusCode).toBe(200);
		const after = await request(api.url).get(`/items/${fixture.table}/1`).auth(api.adminToken, { type: 'bearer' });
		expect(Number(after.body.data.price)).toBe(price);
		expectComputed(fixture, after.body.data);

		const row = await api.database(fixture.table).where({ id: 1 }).first();
		const [column] = Object.keys(fixture.generated);

		const rejected = await request(api.url)
			.patch(`/items/${fixture.table}/1`)
			.auth(api.adminToken, { type: 'bearer' })
			.send({ [column!]: 1 });

		expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
		expect(await api.database(fixture.table).where({ id: 1 }).first()).toEqual(row);
	});

	test('a role without access cannot read the fields or items', async ({ api }) => {
		for (const path of [`/fields/${fixture.table}`, `/items/${fixture.table}`]) {
			const response = await request(api.url).get(path).auth(USER['APP_ACCESS']!.TOKEN, { type: 'bearer' });
			expect(response.statusCode, path).toBe(403);
		}
	});
}

function staleSnapshot(fixture: Fixture, column: string) {
	test(`a snapshot that marks ${column} as ordinary fails to apply and changes nothing`, async ({ api }) => {
		const before = await generatedState(api, fixture);
		const desired = await snapshot(api);

		const entry = desired.fields.find(
			(field: { collection: string; field: string }) => field.collection === fixture.table && field.field === column
		);

		entry.schema.is_generated = false;
		entry.schema.generation_expression = null;

		const planned = await diff(api, desired);
		expect(planned.statusCode).toBe(200);
		expect(planned.body.data.diff.fields).toHaveLength(1);
		expect(planned.body.data.diff.fields[0]).toMatchObject({ collection: fixture.table, field: column });

		expect(planned.body.data.diff.fields[0].diff).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: 'E', path: ['schema', 'is_generated'], rhs: false }),
				expect.objectContaining({ kind: 'E', path: ['schema', 'generation_expression'], rhs: null }),
			])
		);

		expect(planned.body.data.diff.fields[0].diff).toHaveLength(2);
		expect((await apply(api, planned.body.data)).statusCode).toBeGreaterThanOrEqual(400);
		expect(await generatedState(api, fixture)).toEqual(before);
	});
}

const postgresWith = (capability: string) =>
	vendorsWith(capability).filter((vendor) => familyOf(vendor) === 'postgres');

describeForVendors(
	'stored generated columns',
	vendorsWith('generated-columns'),
	'Requires an engine with stored generated columns, which PostgreSQL 10 lacks.',
	() => coverage(storedFixture)
);

describeForVendors(
	'virtual generated columns',
	vendorsWith('virtual-generated-columns'),
	'Requires an engine with virtual generated columns, which PostgreSQL adds in 18.',
	() => coverage(virtualFixture)
);

describeForVendors(
	'stale virtual column snapshot',
	postgresWith('virtual-generated-columns'),
	'Only PostgreSQL 18 snapshots taken before the inspector recognized virtual columns record them as ordinary.',
	() => staleSnapshot(virtualFixture, 'total_virtual')
);

describeForVendors(
	'stale stored column snapshot',
	postgresWith('generated-columns'),
	'Control for the PostgreSQL stale virtual column case, on the PostgreSQL lanes with stored generated columns.',
	() => staleSnapshot(storedFixture, 'total_stored')
);
