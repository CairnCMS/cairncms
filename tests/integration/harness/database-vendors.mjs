// Pin engine versions and SQL settings so tag updates cannot silently change test behavior.
export const databaseVendors = {
	sqlite3: { client: 'sqlite3', family: 'sqlite', capabilities: [], version: 'SQLite' },
	postgres13: {
		client: 'pg',
		family: 'postgres',
		capabilities: ['postgis'],
		version: 'PostgreSQL 13 / PostGIS 3.4',
		image: 'postgis/postgis@sha256:3ce9b8f4d0711d33cc5fa5e6c00dcb7965fa41467f78c0f3bc7fc7bc2357d85b',
		port: 5432,
		user: 'integration',
		database: 'postgres',
		environment: { POSTGRES_PASSWORD: 'integration', POSTGRES_USER: 'integration', POSTGRES_DB: 'postgres' },
		health: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U integration -d postgres'],
	},
	postgres10: {
		client: 'pg',
		family: 'postgres',
		capabilities: ['postgis'],
		version: 'PostgreSQL 10 / PostGIS 3.2',
		image: 'postgis/postgis@sha256:7e3e68a36d53bc87e0dc33dca14b437b81f71670358c427f996b1e113b786ed6',
		port: 5432,
		user: 'integration',
		database: 'postgres',
		environment: { POSTGRES_PASSWORD: 'integration', POSTGRES_USER: 'integration', POSTGRES_DB: 'postgres' },
		health: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U integration -d postgres'],
	},
	mysql84: {
		client: 'mysql2',
		family: 'mysql',
		capabilities: [],
		version: 'MySQL 8.4',
		image: 'mysql@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb',
		port: 3306,
		user: 'root',
		database: 'mysql',
		environment: { MYSQL_ROOT_PASSWORD: 'integration', MYSQL_ROOT_HOST: '%' },
		command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci'],
		health: ['CMD-SHELL', 'mysqladmin ping --host=127.0.0.1 --user=root --password=integration --silent'],
	},
	mysql5: {
		client: 'mysql2',
		family: 'mysql',
		capabilities: [],
		version: 'MySQL 5.7',
		image: 'mysql@sha256:4bc6bc963e6d8443453676cae56536f4b8156d78bae03c0145cbe47c2aad73bb',
		port: 3306,
		user: 'root',
		database: 'mysql',
		environment: { MYSQL_ROOT_PASSWORD: 'integration', MYSQL_ROOT_HOST: '%' },
		command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci'],
		health: ['CMD-SHELL', 'mysqladmin ping --host=127.0.0.1 --user=root --password=integration --silent'],
	},
	maria114: {
		client: 'mysql2',
		family: 'maria',
		capabilities: [],
		version: 'MariaDB 11.4',
		image: 'mariadb@sha256:67873d30a17f6a9c331f06363b2fa15f38abca415529966d67c84f87f82439fe',
		port: 3306,
		user: 'root',
		database: 'mysql',
		environment: { MYSQL_ROOT_PASSWORD: 'integration', MYSQL_ROOT_HOST: '%' },
		command: ['--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci'],
		health: ['CMD-SHELL', 'mariadb-admin ping --host=127.0.0.1 --user=root --password=integration --silent'],
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
