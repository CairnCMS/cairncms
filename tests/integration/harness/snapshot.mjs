import * as mysql from './mysql-snapshot.mjs';
import * as postgres from './postgres-snapshot.mjs';
import * as sqlite from './sqlite-snapshot.mjs';
import { familyOf, vendors } from './database-vendors.mjs';

export { snapshotHash } from './snapshot-tools.mjs';
export const snapshotVendors = Object.freeze(
	vendors.filter((vendor) => ['sqlite', 'postgres', 'mysql', 'maria'].includes(familyOf(vendor)))
);

const adapter = (vendor) => {
	const family = familyOf(vendor);
	if (family === 'sqlite') return sqlite;
	return family === 'postgres' ? postgres : mysql;
};

export const snapshotCommand = (options) => adapter(options.vendor).snapshotCommand(options);
export const snapshotInventory = (database, name, signal, options) =>
	adapter(options.vendor).snapshotInventory(database, name, signal, options);
