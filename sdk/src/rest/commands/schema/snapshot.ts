import type { RestCommand } from '../../types.js';

// TODO improve typing
export type SchemaSnapshotOutput = {
	version: number;
	directus: string;
	vendor: string;
	collections: Record<string, any>[];
	fields: Record<string, any>[];
	relations: Record<string, any>[];
};

/**
 * A version 2 snapshot, which records upload folders by folder key and stamps the producing release as `release`.
 * Request it through `customEndpoint` against `/schema/snapshot?version=2`.
 */
export type SchemaSnapshotV2Output = {
	version: 2;
	release: string;
	vendor: string;
	collections: Record<string, any>[];
	fields: Record<string, any>[];
	relations: Record<string, any>[];
};

/**
 * Retrieve the current schema as a version 1 snapshot. This endpoint is only available to admin users.
 * @returns Returns the JSON object containing schema details.
 */
export const schemaSnapshot =
	<Schema>(): RestCommand<SchemaSnapshotOutput, Schema> =>
	() => ({
		method: 'GET',
		path: '/schema/snapshot',
		params: { version: 1 },
	});
