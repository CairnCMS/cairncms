import type { Knex } from 'knex';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const distPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../dist/services/graphql/index.js');
const describeIfBuilt = existsSync(distPath) ? describe : describe.skip;

function field(name: string, type: string): Record<string, unknown> {
	return {
		field: name,
		defaultValue: null,
		nullable: true,
		generated: false,
		type,
		dbType: null,
		precision: null,
		scale: null,
		special: [],
		note: null,
		validation: null,
		alias: false,
	};
}

function collection(name: string): Record<string, unknown> {
	return {
		collection: name,
		primary: 'id',
		singleton: false,
		sortField: null,
		note: null,
		accountability: null,
		fields: { id: field('id', 'integer'), title: field('title', 'string') },
	};
}

function schemaOf(...names: string[]): Record<string, unknown> {
	return { collections: Object.fromEntries(names.map((name) => [name, collection(name)])), relations: [] };
}

const accountability = { role: null, admin: true };
const knex = {} as Knex;

describeIfBuilt('GraphQL subscription schema generation (production-realm dist probe)', () => {
	const { GraphQLService } = require(distPath);

	it('generates a _mutated subscription field, EventEnum, and Subscription root for an items collection', () => {
		const service = new GraphQLService({ accountability, knex, schema: schemaOf('articles'), scope: 'items' });
		const sdl = service.getSchema('sdl') as string;

		expect(sdl).toContain('type Subscription');
		expect(sdl).toContain('articles_mutated');
		expect(sdl).toContain('enum EventEnum');
	});

	it('never drops a subscription field when a collection collides with a _mutated type name', () => {
		const service = new GraphQLService({
			accountability,
			knex,
			schema: schemaOf('articles', 'articles_mutated'),
			scope: 'items',
		});

		const sdl = service.getSchema('sdl') as string;

		expect(sdl).toContain('articles_mutated(event:');
		expect(sdl).toContain('articles_mutated_mutated(event:');
	});

	it('does not throw when a collection is named EventEnum', () => {
		const service = new GraphQLService({ accountability, knex, schema: schemaOf('EventEnum'), scope: 'items' });

		expect(() => service.getSchema('sdl')).not.toThrow();
	});

	it('omits subscriptions from the system scope', () => {
		const service = new GraphQLService({ accountability, knex, schema: schemaOf('articles'), scope: 'system' });
		const sdl = service.getSchema('sdl') as string;

		expect(sdl).not.toContain('articles_mutated');
	});
});
