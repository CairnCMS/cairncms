import { assertType, describe, it } from 'vitest';
import { schemaDiff } from '../src/index.js';
import type { SchemaSnapshotOutput, SchemaSnapshotV2Output } from '../src/index.js';

describe('schema command types', () => {
	it('keeps the published version 1 output requiring a directus release string', () => {
		const v1: SchemaSnapshotOutput = {
			version: 1,
			directus: '1.0.0',
			vendor: 'postgres',
			collections: [],
			fields: [],
			relations: [],
		};

		assertType<string>(v1.directus);

		// @ts-expect-error directus is required on the published version 1 output
		const missingDirectus: SchemaSnapshotOutput = {
			version: 1,
			vendor: 'postgres',
			collections: [],
			fields: [],
			relations: [],
		};

		void missingDirectus;
	});

	it('accepts a version 2 snapshot in schemaDiff without a cast', () => {
		const v2: SchemaSnapshotV2Output = {
			version: 2,
			release: '1.0.0',
			vendor: 'postgres',
			collections: [],
			fields: [],
			relations: [],
		};

		schemaDiff(v2);
	});
});
