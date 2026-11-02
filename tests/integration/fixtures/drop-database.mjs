import { familyOf } from '../harness/database-vendors.mjs';

export function dropDatabase(admin, name, vendor, { ifExists = false } = {}) {
	// MySQL-family DROP DATABASE performs DDL for every table; large schema
	// fixtures outlive the short deadline used by ordinary administrative queries.
	const timeout = familyOf(vendor) === 'postgres' ? 10_000 : 60_000;
	return admin.raw(ifExists ? 'DROP DATABASE IF EXISTS ??' : 'DROP DATABASE ??', [name]).timeout(timeout);
}
