import { describe, expect, it } from 'vitest';
import { schemaDiff, schemaSnapshot } from '../src/index.js';
import type { SchemaSnapshotOutput, SchemaSnapshotV2Output } from '../src/index.js';

const v1: SchemaSnapshotOutput = {
	version: 1,
	directus: '1.0.0',
	vendor: 'postgres',
	collections: [],
	fields: [],
	relations: [],
};

const v2: SchemaSnapshotV2Output = {
	version: 2,
	release: '1.0.0',
	vendor: 'postgres',
	collections: [],
	fields: [],
	relations: [],
};

describe('schema command request construction', () => {
	it('pins schemaSnapshot to version 1', () => {
		const req = schemaSnapshot()();

		expect(req.method).toBe('GET');
		expect(req.path).toBe('/schema/snapshot');
		expect(req.params).toEqual({ version: 1 });
	});

	it('sends the raw version 1 snapshot body, with force off by default', () => {
		const req = schemaDiff(v1)();

		expect(req.method).toBe('POST');
		expect(req.path).toBe('/schema/diff');
		expect(req.params).toEqual({});
		expect(req.body).toBe(JSON.stringify(v1));
	});

	it('sends the raw version 2 snapshot body', () => {
		expect(schemaDiff(v2)().body).toBe(JSON.stringify(v2));
	});

	it('passes force through', () => {
		expect(schemaDiff(v1, true)().params).toEqual({ force: true });
	});
});
