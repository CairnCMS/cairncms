// Pin engine versions and SQL settings so tag updates cannot silently change test behavior.
const postgres = {
	client: 'pg',
	family: 'postgres',
	port: 5432,
	user: 'integration',
	database: 'postgres',
	environment: { POSTGRES_PASSWORD: 'integration', POSTGRES_USER: 'integration', POSTGRES_DB: 'postgres' },
	health: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U integration -d postgres'],
};

const mysql = {
	client: 'mysql2',
	port: 3306,
	user: 'root',
	database: 'mysql',
	environment: { MYSQL_ROOT_PASSWORD: 'integration', MYSQL_ROOT_HOST: '%' },
	command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci'],
};

const mysqlFamily = {
	...mysql,
	family: 'mysql',
	health: ['CMD-SHELL', 'mysqladmin ping --host=127.0.0.1 --user=root --password=integration --silent'],
};

const mariaFamily = {
	...mysql,
	family: 'maria',
	health: ['CMD-SHELL', 'mariadb-admin ping --host=127.0.0.1 --user=root --password=integration --silent'],
};

export const databaseVendors = {
	sqlite3: {
		client: 'sqlite3',
		family: 'sqlite',
		capabilities: ['generated-columns', 'virtual-generated-columns'],
		version: 'SQLite',
	},
	postgres18: {
		...postgres,
		capabilities: ['postgis', 'generated-columns', 'virtual-generated-columns'],
		version: 'PostgreSQL 18 / PostGIS 3.6',
		image: 'postgis/postgis@sha256:fd143c649af607c6872a1e59ccb3e43c299f207ab975a4c286fbb204b6e6f7b7',
	},
	postgres15: {
		...postgres,
		capabilities: ['generated-columns'],
		version: 'PostgreSQL 15',
		image: 'postgres@sha256:a8e042598834300dfaa17a54f695b87b7f25d3490433bbbe2ef3bffbb9747f24',
	},
	postgres10: {
		...postgres,
		capabilities: ['postgis'],
		version: 'PostgreSQL 10 / PostGIS 3.2',
		image: 'postgis/postgis@sha256:7e3e68a36d53bc87e0dc33dca14b437b81f71670358c427f996b1e113b786ed6',
	},
	mysql97: {
		...mysqlFamily,
		capabilities: ['generated-columns', 'virtual-generated-columns'],
		version: 'MySQL 9.7',
		image: 'mysql@sha256:8fb11c38b3551e22d50adbb688f027f8ff4ea2d2445aa277c1cc97b4af85ec54',
	},
	mysql84: {
		...mysqlFamily,
		capabilities: ['generated-columns', 'virtual-generated-columns'],
		version: 'MySQL 8.4',
		image: 'mysql@sha256:76f0358884cb92d9a086d24e5671c38048d3fef40f2588703d73eb55392d6b69',
	},
	mysql5: {
		...mysqlFamily,
		capabilities: ['generated-columns', 'virtual-generated-columns'],
		version: 'MySQL 5.7',
		image: 'mysql@sha256:4bc6bc963e6d8443453676cae56536f4b8156d78bae03c0145cbe47c2aad73bb',
	},
	maria123: {
		...mariaFamily,
		capabilities: ['generated-columns', 'virtual-generated-columns'],
		version: 'MariaDB 12.3',
		image: 'mariadb@sha256:99c125f103f5d081ebbc9ffe064e63daf7f688ac33a5f7f29af2d7260a96debf',
	},
	maria1011: {
		...mariaFamily,
		capabilities: ['generated-columns', 'virtual-generated-columns'],
		version: 'MariaDB 10.11',
		image: 'mariadb@sha256:0d0945c57f75b3a3b9ebe71aedaaad005fa5305054e8fca3d2e42a8c92b43b5e',
	},
};

export const vendors = Object.keys(databaseVendors);
export const families = [...new Set(vendors.map((vendor) => databaseVendors[vendor].family))];

export function familyOf(vendor) {
	const definition = databaseVendors[vendor];
	if (!definition) throw new Error(`Unknown vendor: ${vendor}`);
	return definition.family;
}

export const isMysqlFamily = (vendor) => ['mysql', 'maria'].includes(familyOf(vendor));
export const vendorsOf = (family) => vendors.filter((vendor) => databaseVendors[vendor].family === family);
export const hasCapability = (vendor, capability) =>
	databaseVendors[vendor]?.capabilities.includes(capability) ?? false;
export const vendorsWith = (capability) => vendors.filter((vendor) => hasCapability(vendor, capability));

export function expandVendors(selectors) {
	const expanded = [];

	for (const selector of selectors) {
		if (vendors.includes(selector)) expanded.push(selector);
		else if (families.includes(selector)) expanded.push(...vendorsOf(selector));
		else throw new Error(`Unknown vendor or family: ${selector}`);
	}

	return [...new Set(expanded)];
}
