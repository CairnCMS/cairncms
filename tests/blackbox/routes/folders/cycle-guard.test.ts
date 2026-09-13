import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { randomUUID } from 'crypto';
import request from 'supertest';

const run = randomUUID().replace(/-/g, '');
const admin = `Bearer ${common.USER.ADMIN!.TOKEN}`;

const serverVendors = vendors.filter((vendor) => vendor !== 'sqlite3');

const eachServerVendor = (name: string, fn: (vendor: string) => Promise<void>): void => {
	if (serverVendors.length > 0) it.each(serverVendors)(name, fn);
	else it.skip(name, () => undefined);
};

const createdFolderIds: Record<string, string[]> = {};
const createdFileIds: Record<string, string[]> = {};
const createdUserIds: Record<string, string[]> = {};
const deletedFolderIds: Record<string, string[]> = {};

function track(map: Record<string, string[]>, vendor: string, id: unknown): void {
	if (typeof id === 'string') map[vendor]!.push(id);
}

async function createFolder(vendor: string, body: Record<string, unknown> = {}): Promise<{ id: string; key: string }> {
	const response = await request(getUrl(vendor))
		.post('/folders')
		.set('Authorization', admin)
		.send({ name: `Cycle ${randomUUID()}`, ...body });

	track(createdFolderIds, vendor, response.body?.data?.id);
	expect(response.statusCode).toBe(200);

	return { id: response.body.data.id, key: response.body.data.key };
}

async function createFile(vendor: string, folderId: string): Promise<string> {
	const response = await request(getUrl(vendor))
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

async function moveFolder(vendor: string, id: string, parent: string | null) {
	return request(getUrl(vendor)).patch(`/folders/${id}`).set('Authorization', admin).send({ parent });
}

async function folderParent(vendor: string, id: string): Promise<string | null> {
	const response = await request(getUrl(vendor))
		.get(`/folders/${id}`)
		.query({ fields: ['parent'] })
		.set('Authorization', admin);

	expect(response.statusCode).toBe(200);

	return response.body.data.parent ?? null;
}

async function fileFolder(vendor: string, id: string): Promise<string | null> {
	const response = await request(getUrl(vendor))
		.get(`/files/${id}`)
		.query({ fields: ['folder'] })
		.set('Authorization', admin);

	expect(response.statusCode).toBe(200);

	return response.body.data.folder ?? null;
}

async function requireDelete(vendor: string, path: string, failures: string[]): Promise<void> {
	try {
		const response = await request(getUrl(vendor)).delete(path).set('Authorization', admin);

		if (response.statusCode !== 200 && response.statusCode !== 204) {
			failures.push(`DELETE ${path} returned ${response.statusCode}`);
		}
	} catch (error) {
		failures.push(`DELETE ${path} threw ${(error as Error).message}`);
	}
}

describe('folder parent-cycle guard and config deletion guard', () => {
	beforeAll(() => {
		for (const vendor of vendors) {
			createdFolderIds[vendor] = [];
			createdFileIds[vendor] = [];
			createdUserIds[vendor] = [];
			deletedFolderIds[vendor] = [];
		}
	});

	afterAll(async () => {
		const failures: string[] = [];

		for (const vendor of vendors) {
			for (const id of createdUserIds[vendor] ?? []) await requireDelete(vendor, `/users/${id}`, failures);
			for (const id of createdFileIds[vendor] ?? []) await requireDelete(vendor, `/files/${id}`, failures);

			const deleted = new Set(deletedFolderIds[vendor] ?? []);
			const remaining = (createdFolderIds[vendor] ?? []).filter((id) => !deleted.has(id));

			for (const id of remaining) {
				try {
					const response = await moveFolder(vendor, id, null);

					if (response.statusCode !== 200) failures.push(`reparent ${id} returned ${response.statusCode}`);
				} catch (error) {
					failures.push(`reparent ${id} threw ${(error as Error).message}`);
				}
			}

			for (const id of remaining) await requireDelete(vendor, `/folders/${id}`, failures);
		}

		if (failures.length > 0) throw new Error(failures.join('; '));
	});

	it.each(vendors)('refuses a self-parenting move and leaves the folder a root (%s)', async (vendor) => {
		const { id } = await createFolder(vendor);

		const response = await moveFolder(vendor, id, id);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(vendor, id)).toBeNull();
	});

	it.each(vendors)('refuses a self-parenting move with a mixed-case id (%s)', async (vendor) => {
		const { id } = await createFolder(vendor);

		const response = await moveFolder(vendor, id, id.toUpperCase());

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(vendor, id)).toBeNull();
	});

	it.each(vendors)('refuses a move under a nonexistent parent (%s)', async (vendor) => {
		const { id } = await createFolder(vendor);

		const response = await moveFolder(vendor, id, randomUUID());

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(vendor, id)).toBeNull();
	});

	it.each(vendors)('refuses moving a folder under its own descendant (%s)', async (vendor) => {
		const a = await createFolder(vendor);
		const b = await createFolder(vendor);

		expect((await moveFolder(vendor, b.id, a.id)).statusCode).toBe(200);

		const response = await moveFolder(vendor, a.id, b.id);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(vendor, a.id)).toBeNull();
	});

	it.each(vendors)('refuses a descendant cycle even when the parent id is mixed-case (%s)', async (vendor) => {
		const a = await createFolder(vendor);
		const b = await createFolder(vendor);

		expect((await moveFolder(vendor, b.id, a.id)).statusCode).toBe(200);

		const response = await moveFolder(vendor, a.id, b.id.toUpperCase());

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(vendor, a.id)).toBeNull();
	});

	eachServerVendor('allows a valid move to a mixed-case parent id (%s)', async (vendor) => {
		const a = await createFolder(vendor);
		const b = await createFolder(vendor);

		expect((await moveFolder(vendor, a.id, b.id.toUpperCase())).statusCode).toBe(200);
		expect((await folderParent(vendor, a.id))?.toLowerCase()).toBe(b.id.toLowerCase());
	});

	it.each(vendors)('allows a valid nested file-to-folder move and refuses a cycling one (%s)', async (vendor) => {
		const a = await createFolder(vendor);
		const b = await createFolder(vendor);
		const c = await createFolder(vendor);

		expect((await moveFolder(vendor, b.id, a.id)).statusCode).toBe(200);

		const file = await createFile(vendor, a.id);

		const valid = await request(getUrl(vendor))
			.patch(`/files/${file}`)
			.set('Authorization', admin)
			.send({ folder: { id: a.id, parent: c.id } });

		expect(valid.statusCode).toBe(200);
		expect(await folderParent(vendor, a.id)).toBe(c.id);

		const cycle = await request(getUrl(vendor))
			.patch(`/files/${file}`)
			.set('Authorization', admin)
			.send({ folder: { id: c.id, parent: b.id } });

		expect(cycle.statusCode).toBe(400);
		expect(cycle.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(vendor, c.id)).toBeNull();
		expect(await fileFolder(vendor, file)).toBe(a.id);
	});

	it.each(vendors)('refuses a cycling multi-hop write through a user avatar (%s)', async (vendor) => {
		const a = await createFolder(vendor);
		const b = await createFolder(vendor);

		expect((await moveFolder(vendor, b.id, a.id)).statusCode).toBe(200);

		const file = await createFile(vendor, a.id);

		const created = await request(getUrl(vendor))
			.post('/users')
			.set('Authorization', admin)
			.send({ email: `cycle-${run}-${randomUUID()}@example.com`, avatar: file });

		track(createdUserIds, vendor, created.body?.data?.id);
		expect(created.statusCode).toBe(200);

		const response = await request(getUrl(vendor))
			.patch(`/users/${created.body.data.id}`)
			.set('Authorization', admin)
			.send({ avatar: { id: file, folder: { id: a.id, parent: b.id } } });

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
		expect(await folderParent(vendor, a.id)).toBeNull();
		expect(await fileFolder(vendor, file)).toBe(a.id);
	});

	it.each(vendors)('does not apply the config deletion guard to a direct folder delete (%s)', async (vendor) => {
		const { id } = await createFolder(vendor);
		await createFile(vendor, id);

		const response = await request(getUrl(vendor)).delete(`/folders/${id}`).set('Authorization', admin);

		expect(response.statusCode).toBe(204);
		deletedFolderIds[vendor]!.push(id);
	});

	it.each(vendors)('refuses a config apply that deletes a folder still holding a file (%s)', async (vendor) => {
		const { id, key } = await createFolder(vendor);
		await createFile(vendor, id);

		const snapshot = await request(getUrl(vendor)).get('/config/snapshot').set('Authorization', admin);
		expect(snapshot.statusCode).toBe(200);

		const desired = snapshot.body.data;
		desired.folders = desired.folders.filter((folder: { key: string }) => folder.key !== key);

		const preview = await request(getUrl(vendor))
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

		const apply = await request(getUrl(vendor))
			.post('/config/apply')
			.query({ destructive: 'true' })
			.set('Authorization', admin)
			.set('Content-Type', 'application/json')
			.send(desired);

		expect(apply.statusCode).toBe(400);
		expect(apply.body.errors[0].extensions.code).toBe('CONFIG_FOLDER_IN_USE');
		expect(apply.body.errors[0].extensions.key).toBe(key);
		expect(apply.body.errors[0].extensions.blockedBy).toBe('files');
		expect(await folderParent(vendor, id)).toBeNull();
	});
});
