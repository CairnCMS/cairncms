import { COLLECTIONS } from './constants.js';

/**
 * Raw-HTTP helpers used only by globalSetup. Deliberately does NOT use the
 * vendored SDK — keeps the "thing under test" out of fixture provisioning.
 * Admin auth token obtained here is ephemeral and lives for setup only.
 */

export async function login(url: string, email: string, password: string): Promise<string> {
	const response = await fetch(`${url}/auth/login`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ email, password }),
	});

	if (!response.ok) {
		throw new Error(`Login failed: HTTP ${response.status} ${await response.text()}`);
	}

	const body: any = await response.json();
	return body.data.access_token;
}

async function post(url: string, token: string, path: string, payload: unknown): Promise<void> {
	const response = await fetch(`${url}${path}`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		throw new Error(`POST ${path} failed: HTTP ${response.status} ${await response.text()}`);
	}
}

export async function createCollection(url: string, token: string, name: string): Promise<void> {
	// Provide an explicit UUID primary key. Default behavior without a `fields`
	// array creates an integer auto-increment id column, which would conflict
	// with our fixed-UUID seed data.
	await post(url, token, '/collections', {
		collection: name,
		schema: { name },
		meta: { collection: name, hidden: false, singleton: false },
		fields: [
			{
				field: 'id',
				type: 'uuid',
				schema: { is_primary_key: true, is_nullable: false, length: 36 },
				meta: {
					hidden: true,
					readonly: true,
					interface: 'input',
					special: ['uuid'],
				},
			},
		],
	});
}

export async function createField(
	url: string,
	token: string,
	collection: string,
	field: {
		field: string;
		type: string;
		schema?: Record<string, unknown>;
		meta?: Record<string, unknown>;
	}
): Promise<void> {
	await post(url, token, `/fields/${collection}`, field);
}

export async function createRelation(
	url: string,
	token: string,
	relation: {
		collection: string;
		field: string;
		related_collection: string;
	}
): Promise<void> {
	// `schema: null` makes this a "logical" m2o — Directus metadata only, no
	// DB-level foreign key constraint. Required for SQLite (doesn't support
	// ALTER TABLE ADD CONSTRAINT FK) and sufficient for filter-DSL joins.
	await post(url, token, '/relations', { ...relation, schema: null });
}

/** Grant the public role (sentinel) read access to a single fixture collection. */
export async function grantPublicRead(url: string, token: string, collection: string): Promise<void> {
	const PUBLIC_ROLE_ID = '00000000-0000-0000-0000-000000000000';

	await post(url, token, '/permissions', {
		role: PUBLIC_ROLE_ID,
		collection,
		action: 'read',
		fields: '*',
	});
}

/** Build the three fixture collections with their fields and the one m2o relation. */
export async function applySchemaFixture(url: string, token: string): Promise<void> {
	// Categories
	await createCollection(url, token, COLLECTIONS.categories);

	await createField(url, token, COLLECTIONS.categories, {
		field: 'name',
		type: 'string',
		schema: { is_nullable: false },
	});

	// Public items (public-readable)
	await createCollection(url, token, COLLECTIONS.publicItems);

	await createField(url, token, COLLECTIONS.publicItems, {
		field: 'name',
		type: 'string',
		schema: { is_nullable: false },
	});

	// Items (with m2o to categories + scalar fields)
	await createCollection(url, token, COLLECTIONS.items);

	await createField(url, token, COLLECTIONS.items, {
		field: 'name',
		type: 'string',
		schema: { is_nullable: false },
	});

	await createField(url, token, COLLECTIONS.items, {
		field: 'value',
		type: 'integer',
		schema: { is_nullable: false, default_value: 0 },
	});

	await createField(url, token, COLLECTIONS.items, {
		field: 'category',
		type: 'uuid',
		schema: {},
		meta: { interface: 'select-dropdown-m2o', special: ['m2o'] },
	});

	await createRelation(url, token, {
		collection: COLLECTIONS.items,
		field: 'category',
		related_collection: COLLECTIONS.categories,
	});
}
