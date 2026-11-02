import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
	databaseVendors,
	expandVendors,
	families,
	familyOf,
	hasCapability,
	isMysqlFamily,
	vendors,
	vendorsOf,
	vendorsWith,
} from './database-vendors.mjs';

test('every vendor declares a family, a capability list, a label, and a digest-pinned image', () => {
	for (const vendor of vendors) {
		const definition = databaseVendors[vendor];
		assert(families.includes(definition.family), `${vendor} family`);
		assert(Array.isArray(definition.capabilities), `${vendor} capabilities`);
		assert(typeof definition.version === 'string' && definition.version.trim(), `${vendor} label`);
		if (definition.image) assert.match(definition.image, /@sha256:[0-9a-f]{64}$/, `${vendor} image pin`);
	}
});

test('family names and vendor keys are disjoint', () => {
	assert.deepEqual(
		families.filter((family) => vendors.includes(family)),
		[]
	);

	assert.deepEqual(families, ['sqlite', 'postgres', 'mysql', 'maria']);
});

test('vendorsOf returns every key of a family and nothing else', () => {
	for (const family of families) {
		const expected = vendors.filter((vendor) => databaseVendors[vendor].family === family);
		assert.deepEqual(vendorsOf(family), expected);
		assert(expected.length > 0, `${family} has at least one lane`);
		for (const vendor of expected) assert.equal(familyOf(vendor), family);
	}

	assert.deepEqual(vendorsOf('unknown'), []);
	assert.throws(() => familyOf('unknown'), /Unknown vendor: unknown/);
});

test('isMysqlFamily covers MySQL and MariaDB only', () => {
	for (const vendor of vendors)
		assert.equal(isMysqlFamily(vendor), ['mysql', 'maria'].includes(familyOf(vendor)), vendor);
});

test('capabilities select exactly the vendors that declare them', () => {
	const expected = vendors.filter((vendor) => databaseVendors[vendor].capabilities.includes('postgis'));
	assert.deepEqual(vendorsWith('postgis'), expected);
	assert(expected.length > 0);
	for (const vendor of vendors) assert.equal(hasCapability(vendor, 'postgis'), expected.includes(vendor));
	assert.equal(hasCapability('unknown', 'postgis'), false);
	assert.deepEqual(vendorsWith('unknown'), []);
});

test('every declared capability is a known name, and virtual generated columns imply stored ones', () => {
	const known = ['postgis', 'generated-columns', 'virtual-generated-columns'];

	for (const vendor of vendors) {
		for (const capability of databaseVendors[vendor].capabilities)
			assert(known.includes(capability), `${vendor} declares unknown capability ${capability}`);
	}

	for (const vendor of vendorsWith('virtual-generated-columns'))
		assert(hasCapability(vendor, 'generated-columns'), `${vendor} has virtual but not stored generated columns`);
});

test('expandVendors expands families, passes keys through, de-duplicates, and rejects unknown names', () => {
	assert.deepEqual(expandVendors(['postgres']), vendorsOf('postgres'));

	assert.deepEqual(expandVendors(['postgres', 'mysql', 'maria']), [
		...vendorsOf('postgres'),
		...vendorsOf('mysql'),
		...vendorsOf('maria'),
	]);

	assert.deepEqual(expandVendors(['sqlite3']), ['sqlite3']);
	const mysql = vendorsOf('mysql');
	assert.deepEqual(expandVendors(['mysql5', 'mysql']), ['mysql5', ...mysql.filter((vendor) => vendor !== 'mysql5')]);
	assert.deepEqual(expandVendors(['sqlite', 'sqlite3']), ['sqlite3']);
	assert.throws(() => expandVendors(['postgres', 'nope']), /Unknown vendor or family: nope/);
	assert.throws(() => expandVendors(['']), /Unknown vendor or family: /);
	assert.deepEqual(expandVendors([]), []);
});
