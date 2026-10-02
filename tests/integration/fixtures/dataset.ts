import { expect } from 'vitest';
import { createIdentityTest } from './identities';
import type { Api } from './environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';
import type { CachedTestsSchema, TestsSchemaVendorValues } from '../query/filter';

type Snapshot = { table: string; rows: Record<string, any>[]; jsonColumns: Set<string> }[];
type Dataset = { values: TestsSchemaVendorValues; snapshot: Snapshot };
type DatasetOptions = {
	cachedSchema: CachedTestsSchema;
	tables: string[];
	seedDBStructure: (api: Api, vendor: string) => Promise<void>;
	seedDBValues: (api: Api, vendor: string, schema: CachedTestsSchema, values: TestsSchemaVendorValues) => Promise<void>;
};

async function restore(api: Api, snapshot: Snapshot) {
	// Keep foreign keys active: remove children first, then restore parents first.
	await api.database.transaction(async (transaction) => {
		for (const { table } of [...snapshot].reverse()) await transaction(table).delete();

		for (const { table, rows, jsonColumns } of snapshot) {
			for (let offset = 0; offset < rows.length; offset += 20) {
				const batch = rows
					.slice(offset, offset + 20)
					.map((row) =>
						Object.fromEntries(
							Object.entries(row).map(([key, value]) => [
								key,
								value !== null && jsonColumns.has(key) ? JSON.stringify(value) : value,
							])
						)
					);

				await transaction(table).insert(batch);
			}
		}
	});
}

export const createDatasetTest = (options: DatasetOptions) =>
	createIdentityTest().extend<{
		datasetState: Prerequisite<Dataset>;
		dataset: Dataset;
	}>({
		datasetState: [
			async ({ apiState, identityState, vendor, teardownFailures }, use) => {
				if (!apiState.ok) return use(apiState);
				if (!identityState.ok) return use(identityState);
				const api = apiState.value;

				await capturePrerequisite<Dataset>(
					async (ready) => {
						const started = performance.now();
						await options.seedDBStructure(api, vendor);
						const values: TestsSchemaVendorValues = {};
						await options.seedDBValues(api, vendor, options.cachedSchema, values);
						const snapshot: Snapshot = [];

						for (const table of options.tables) {
							const columns = await api.database(table).columnInfo();
							const rows = await api.database(table).orderBy('id');

							const jsonColumns = new Set(
								Object.entries(columns)
									.filter(
										([, info]) => vendor !== 'sqlite3' && vendor !== 'maria' && ['json', 'jsonb'].includes(info.type)
									)
									.map(([name]) => name)
							);

							snapshot.push({ table, rows, jsonColumns });
						}

						// An incorrect driver conversion must fail setup, before any filter assertion can pass on changed data.
						await restore(api, snapshot);
						for (const { table, rows } of snapshot) expect(await api.database(table).orderBy('id')).toEqual(rows);
						api.recordTiming('relational-schema-and-values', started);
						await ready({ values, snapshot });
					},
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		dataset: [
			async ({ api, identities, datasetState, task, skip }, use) => {
				void identities;
				const state = requirePrerequisite(datasetState, 'relational schema and values', { task, skip });
				await restore(api, state.snapshot);
				await use(state);
			},
			{ auto: true },
		],
	});
