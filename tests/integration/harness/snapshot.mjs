import * as mysql from './mysql-snapshot.mjs';
import * as postgres from './postgres-snapshot.mjs';
import * as sqlite from './sqlite-snapshot.mjs';

export { snapshotHash } from './snapshot-tools.mjs';
export const snapshotVendors = Object.freeze([...mysql.snapshotVendors, 'postgres', 'postgres10', 'sqlite3']);

const adapter = (vendor) => {
	if (vendor === 'sqlite3') return sqlite;
	return vendor.startsWith('postgres') ? postgres : mysql;
};

export const snapshotCommand = (options) => adapter(options.vendor).snapshotCommand(options);
export const snapshotInventory = (database, name, signal, options = {}) =>
	adapter(options.vendor ?? 'mysql').snapshotInventory(database, name, signal, options);
