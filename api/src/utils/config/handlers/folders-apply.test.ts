import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FoldersService } from '../../../services/folders.js';
import type { ConfigFolder } from '../../../types/config.js';
import type { ApplyContext } from '../descriptor.js';
import { foldersDescriptor, type FoldersKindTypes } from './folders.js';

const schema = {
	collections: { directus_folders: { collection: 'directus_folders', primary: 'id', fields: {} } },
	relations: [],
} as unknown as SchemaOverview;

function fakeDb(rows: Record<string, unknown>[]): Knex {
	return ((_table: string) => ({ select: () => Promise.resolve(rows) })) as unknown as Knex;
}

function context(rows: Record<string, unknown>[]): ApplyContext<FoldersKindTypes> {
	return {
		database: fakeDb(rows),
		schema,
		securityContext: { mode: 'system', reason: 'local config apply', accountability: {} as never },
		mutationOptions: {} as never,
		dependency: (() => undefined) as never,
	};
}

function folder(key: string, parent: string | null = null): ConfigFolder {
	return { key, name: key, parent };
}

afterEach(() => vi.restoreAllMocks());

describe('folders applyCreates ordering', () => {
	it('creates parents before children and resolves nested parents to their new ids', async () => {
		const calls: Array<{ key: string; parent: unknown }> = [];

		vi.spyOn(FoldersService.prototype, 'createOne').mockImplementation(async (data: Record<string, unknown>) => {
			calls.push({ key: data['key'] as string, parent: data['parent'] });
			return `id-${data['key']}`;
		});

		await foldersDescriptor.handler.applyCreates(
			[folder('child', 'parent'), folder('parent'), folder('grandchild', 'child')],
			context([])
		);

		expect(calls.map((call) => call.key)).toEqual(['parent', 'child', 'grandchild']);
		expect(calls).toContainEqual({ key: 'parent', parent: null });
		expect(calls).toContainEqual({ key: 'child', parent: 'id-parent' });
		expect(calls).toContainEqual({ key: 'grandchild', parent: 'id-child' });
	});
});

describe('folders applyUpdates ordering', () => {
	it('writes each reparented folder once, after its desired parent reaches its final position', async () => {
		const calls: Array<{ id: string; parent: unknown }> = [];

		vi.spyOn(FoldersService.prototype, 'updateOne').mockImplementation(
			async (id: unknown, data: Record<string, unknown>) => {
				calls.push({ id: id as string, parent: data['parent'] });
				return id as string;
			}
		);

		await foldersDescriptor.handler.applyUpdates(
			[
				{ key: 'a', changes: { parent: { before: null, after: 'b' } } },
				{ key: 'b', changes: { parent: { before: 'a', after: null } } },
			],
			context([
				{ id: 'id-a', key: 'a' },
				{ id: 'id-b', key: 'b' },
			])
		);

		expect(calls).toEqual([
			{ id: 'id-b', parent: null },
			{ id: 'id-a', parent: 'id-b' },
		]);
	});
});

describe('folders applyDeletes ordering', () => {
	it('deletes children before their parents using the current tree', async () => {
		const deleted: string[] = [];

		vi.spyOn(FoldersService.prototype, 'deleteOne').mockImplementation(async (id: unknown) => {
			deleted.push(id as string);
			return id as string;
		});

		await foldersDescriptor.handler.applyDeletes(
			['parent', 'child'],
			context([
				{ id: 'id-parent', key: 'parent', parent: null },
				{ id: 'id-child', key: 'child', parent: 'id-parent' },
			])
		);

		expect(deleted).toEqual(['id-child', 'id-parent']);
	});
});
