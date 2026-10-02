import type { Api } from '../../fixtures/environment';
import { CreateCollection, PRIMARY_KEY_TYPES } from '../../fixtures/data';
import { seedDBStructure as common, collectionNameM2O, collectionNameO2M } from '../../common/common.seed';
import { seedDBStructure as fields } from '../fields/crud.seed';
import { seedDBStructure as changes } from '../fields/change-fields.seed';
import { seedDBStructure as simple } from '../items/no-relation.seed';
import { seedDBStructure as conceal } from '../items/conceal-filter.seed';
import { seedDBStructure as hash } from '../items/hash-filter.seed';
import { seedDBStructure as aggregation } from '../items/aggregation-count.seed';
import { seedDBStructure as singleton } from '../items/singleton.seed';
import { seedDBStructure as flags } from '../items/flag-operator-filter.seed';
import { geometryVendors, seedDBStructure as geometry } from '../items/geometry-bbox-filter.seed';
import { seedDBStructure as m2o } from '../items/m2o.seed';
import { seedDBStructure as o2m } from '../items/o2m.seed';
import { seedDBStructure as m2m } from '../items/m2m.seed';
import { seedDBStructure as m2a } from '../items/m2a.seed';
import { seedDBStructure as realtime } from '../realtime/realtime.seed';
import { prepareListingTables } from '../collections/schema-fixtures';

// Round trips include unrelated schemas to detect collateral changes.
export async function prepareBackground(api: Api, vendor: string) {
	await prepareListingTables(api);

	await api.database.schema.createTable('tests_extensions_log', (table) => {
		table.increments('id').primary();
		table.string('key');
		table.string('value');
	});

	await common(api);
	await fields(api);
	await changes(api);
	await simple(api);
	await conceal(api);
	await hash(api);
	await aggregation(api);
	await singleton(api);
	await flags(api);
	if (geometryVendors.includes(vendor)) await geometry(api);
	await m2o(api, vendor);
	await o2m(api, vendor);
	await m2m(api, vendor);
	await m2a(api, vendor);
	await realtime(api);
	// Include empty collections in the snapshot round trip.
	await CreateCollection(api, { collection: collectionNameM2O });
	await CreateCollection(api, { collection: collectionNameO2M });
	if (PRIMARY_KEY_TYPES.length !== 3) throw new Error('Snapshot background requires all three primary-key variants');
}
