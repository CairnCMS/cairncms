import { setupRequest } from '../../fixtures/request';
import { describe, expect, inject } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createScenarioTest } from '../../fixtures/scenario';
import { describeForVendors } from '../../fixtures/applicability';
import * as common from '../../fixtures/data';
import { randomUUID } from 'crypto';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const vendor = inject('integration').vendor;

initializeFixtures();

const run = randomUUID().replace(/-/g, '');
const admin = `Bearer ${common.USER.ADMIN!.TOKEN}`;

const createdFolderIds: Record<string, string[]> = {};
const createdFileIds: Record<string, string[]> = {};
const createdUserIds: Record<string, string[]> = {};
const deletedFolderIds: Record<string, string[]> = {};

function track(map: Record<string, string[]>, vendor: string, id: unknown): void {
	if (typeof id === 'string') map[vendor]!.push(id);
}

async function createFolder(api: Api, body: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
	const response = await setupRequest(api.url)
		.post('/folders')
		.set('Authorization', admin)
		.send({ name: `Cycle ${randomUUID()}`, ...body });

	track(createdFolderIds, vendor, response.body?.data?.id);
	expect(response.statusCode).toBe(200);

	return { id: response.body.data.id, key: response.body.data.key };
}

async function createFile(api: Api, folderId: string): Promise<string> {
	const response = await setupRequest(api.url)
		.post('/files')
		.set('Authorization', admin)
		.send({
			storage: 'local',
			title: `Cycle File ${randomUUID()}`,
			filename_download: 'cycle',
			type: 'application/octet-stream',
			folder: folderId,
		});

	track(createdFileIds, vendor, response.body?.data?.id);
	expect(response.statusCode).toBe(200);

	return response.body.data.id;
}

async function moveFolder(api: Api, id: string, parent: string | null) {
	return request(api.url).patch(`/folders/${id}`).set('Authorization', admin).send({ parent });
}

async function folderParent(api: Api, id: string): Promise<string | null> {
	const response = await request(api.url)
		.get(`/folders/${id}`)
		.query({ fields: ['parent'] })
		.set('Authorization', admin);

	expect(response.statusCode).toBe(200);

	return response.body.data.parent ?? null;
}

async function fileFolder(api: Api, id: string): Promise<string | null> {
	const response = await request(api.url)
		.get(`/files/${id}`)
		.query({ fields: ['folder'] })
		.set('Authorization', admin);

	expect(response.statusCode).toBe(200);

	return response.body.data.folder ?? null;
}

async function requireDelete(api: Api, path: string, failures: string[]): Promise<void> {
	try {
		const response = await request(api.url).delete(path).set('Authorization', admin);

		if (response.statusCode !== 200 && response.statusCode !== 204) {
			failures.push(`DELETE ${path} returned ${response.statusCode}`);
		}
	} catch (error) {
		failures.push(`DELETE ${path} threw ${(error as Error).message}`);
	}
}

const test = createScenarioTest({
	prepare: async (api, vendor) => {
		createdFolderIds[vendor] = [];
		createdFileIds[vendor] = [];
		createdUserIds[vendor] = [];
		deletedFolderIds[vendor] = [];
	},
	cleanup: async (api, vendor) => {
		const failures: string[] = [];

		for (const id of createdUserIds[vendor] ?? []) await requireDelete(api, `/users/${id}`, failures);
		for (const id of createdFileIds[vendor] ?? []) await requireDelete(api, `/files/${id}`, failures);

		const deleted = new Set(deletedFolderIds[vendor] ?? []);
		const remaining = (createdFolderIds[vendor] ?? []).filter((id) => !deleted.has(id));

		for (const id of remaining) {
			try {
				const response = await moveFolder(api, id, null);

				if (response.statusCode !== 200) failures.push(`reparent ${id} returned ${response.statusCode}`);
			} catch (error) {
				failures.push(`reparent ${id} threw ${(error as Error).message}`);
			}
		}

		for (const id of remaining) await requireDelete(api, `/folders/${id}`, failures);

		if (failures.length > 0) throw new Error(failures.join('; '));
	},
});

describe('folder parent-cycle guard and config deletion guard', () => {
	test('refuses a self-parenting move and leaves the folder a root', async ({ api }) => {
		const { id } = await createFolder(api);

		const response = await moveFolder(api, id, id);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(api, id)).toBeNull();
	});

	test('refuses a self-parenting move with a mixed-case id', async ({ api }) => {
		const { id } = await createFolder(api);

		const response = await moveFolder(api, id, id.toUpperCase());

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(api, id)).toBeNull();
	});

	test('refuses a move under a nonexistent parent', async ({ api }) => {
		const { id } = await createFolder(api);

		const response = await moveFolder(api, id, randomUUID());

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(api, id)).toBeNull();
	});

	test('refuses moving a folder under its own descendant', async ({ api }) => {
		const a = await createFolder(api);
		const b = await createFolder(api);

		expect((await moveFolder(api, b.id, a.id)).statusCode).toBe(200);

		const response = await moveFolder(api, a.id, b.id);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(api, a.id)).toBeNull();
	});

	test('refuses a descendant cycle even when the parent id is mixed-case', async ({ api }) => {
		const a = await createFolder(api);
		const b = await createFolder(api);

		expect((await moveFolder(api, b.id, a.id)).statusCode).toBe(200);

		const response = await moveFolder(api, a.id, b.id.toUpperCase());

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(api, a.id)).toBeNull();
	});

	describeForVendors(
		'server database identifiers',
		['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
		'Mixed-case parent identifiers are tested on server-database collations; SQLite is not validated.',
		() => {
			test('allows a valid move to a mixed-case parent id', async ({ api }) => {
				const a = await createFolder(api);
				const b = await createFolder(api);

				expect((await moveFolder(api, a.id, b.id.toUpperCase())).statusCode).toBe(200);
				expect((await folderParent(api, a.id))?.toLowerCase()).toBe(b.id.toLowerCase());
			});
		}
	);

	test('allows a valid nested file-to-folder move and refuses a cycling one', async ({ api }) => {
		const a = await createFolder(api);
		const b = await createFolder(api);
		const c = await createFolder(api);

		expect((await moveFolder(api, b.id, a.id)).statusCode).toBe(200);

		const file = await createFile(api, a.id);

		const valid = await request(api.url)
			.patch(`/files/${file}`)
			.set('Authorization', admin)
			.send({ folder: { id: a.id, parent: c.id } });

		expect(valid.statusCode).toBe(200);
		expect(await folderParent(api, a.id)).toBe(c.id);

		const cycle = await request(api.url)
			.patch(`/files/${file}`)
			.set('Authorization', admin)
			.send({ folder: { id: c.id, parent: b.id } });

		expect(cycle.statusCode).toBe(400);
		expect(cycle.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(api, c.id)).toBeNull();
		expect(await fileFolder(api, file)).toBe(a.id);
	});

	test('refuses a cycling multi-hop write through a user avatar', async ({ api, vendor }) => {
		const a = await createFolder(api);
		const b = await createFolder(api);

		expect((await moveFolder(api, b.id, a.id)).statusCode).toBe(200);

		const file = await createFile(api, a.id);

		const created = await request(api.url)
			.post('/users')
			.set('Authorization', admin)
			.send({ email: `cycle-${run}-${randomUUID()}@example.com`, avatar: file });

		track(createdUserIds, vendor, created.body?.data?.id);
		expect(created.statusCode).toBe(200);

		const response = await request(api.url)
			.patch(`/users/${created.body.data.id}`)
			.set('Authorization', admin)
			.send({ avatar: { id: file, folder: { id: a.id, parent: b.id } } });

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(api, a.id)).toBeNull();
		expect(await fileFolder(api, file)).toBe(a.id);
	});

	test('does not apply the config deletion guard to a direct folder delete', async ({ api, vendor }) => {
		const { id } = await createFolder(api);
		await createFile(api, id);

		const response = await request(api.url).delete(`/folders/${id}`).set('Authorization', admin);

		expect(response.statusCode).toBe(204);
		deletedFolderIds[vendor]!.push(id);
	});

	test('refuses a config apply that deletes a folder still holding a file', async ({ api }) => {
		const { id, key } = await createFolder(api);
		await createFile(api, id);

		const snapshot = await request(api.url).get('/config/snapshot').set('Authorization', admin);
		expect(snapshot.statusCode).toBe(200);

		const desired = snapshot.body.data;
		desired.folders = desired.folders.filter((folder: { key: string }) => folder.key !== key);

		const preview = await request(api.url)
			.post('/config/apply')
			.query({ dry_run: 'true' })
			.set('Authorization', admin)
			.set('Content-Type', 'application/json')
			.send(desired);

		expect(preview.statusCode).toBe(200);

		const previewed = preview.body.data.changes.find(
			(change: { kind: string; operation: string; identity: { key: string } }) =>
				change.kind === 'folders' && change.operation === 'delete' && change.identity.key === key
		);

		expect(previewed.impact).toEqual([{ blockedBy: 'files' }]);

		const apply = await request(api.url)
			.post('/config/apply')
			.query({ destructive: 'true' })
			.set('Authorization', admin)
			.set('Content-Type', 'application/json')
			.send(desired);

		expect(apply.statusCode).toBe(400);
		expect(apply.body.errors[0].extensions.code).toBe('CONFIG_FOLDER_IN_USE');
		expect(apply.body.errors[0].extensions.key).toBe(key);
		expect(apply.body.errors[0].extensions.blockedBy).toBe('files');
		expect(await folderParent(api, id)).toBeNull();
	});
});
