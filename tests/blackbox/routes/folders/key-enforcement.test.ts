import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { randomUUID } from 'crypto';
import request from 'supertest';

const run = randomUUID().replace(/-/g, '');
const roleName = `Folder Key Limited ${run}`;
const userEmail = `folder-key-limited-${run}@example.com`;
const limitedToken = `FolderKeyLimited${run}`;

const roleIds: Record<string, string> = {};
const userIds: Record<string, string> = {};
const createdFolderIds: Record<string, string[]> = {};
const createdFileIds: Record<string, string[]> = {};

const admin = `Bearer ${common.USER.ADMIN!.TOKEN}`;

function track(map: Record<string, string[]>, vendor: string, id: unknown): void {
	if (typeof id === 'string') map[vendor]!.push(id);
}

async function createFolder(vendor: string, body: Record<string, unknown>) {
	const response = await request(getUrl(vendor)).post('/folders').set('Authorization', admin).send(body);

	track(createdFolderIds, vendor, response.body?.data?.id);

	return response;
}

async function createFile(vendor: string, folderId: string) {
	const response = await request(getUrl(vendor))
		.post('/files')
		.set('Authorization', admin)
		.send({
			storage: 'local',
			title: `Folder Key File ${randomUUID()}`,
			filename_download: 'folder-key',
			type: 'application/octet-stream',
			folder: folderId,
		});

	track(createdFileIds, vendor, response.body?.data?.id);

	return response;
}

async function safeDelete(vendor: string, path: string, failures: string[]): Promise<void> {
	try {
		const response = await request(getUrl(vendor)).delete(path).set('Authorization', admin);

		// Deleting an absent key still returns 204 here, so any other status is a real cleanup failure.
		if (response.statusCode !== 200 && response.statusCode !== 204) {
			failures.push(`DELETE ${path} returned ${response.statusCode}`);
		}
	} catch (error) {
		failures.push(`DELETE ${path} threw ${(error as Error).message}`);
	}
}

describe('folder key enforcement', () => {
	beforeAll(async () => {
		for (const vendor of vendors) {
			createdFolderIds[vendor] = [];
			createdFileIds[vendor] = [];

			const role = await common.CreateRole(vendor, {
				name: roleName,
				appAccessEnabled: true,
				adminAccessEnabled: false,
			});

			expect(role?.id).toBeDefined();
			roleIds[vendor] = role.id;

			const user = await common.CreateUser(vendor, {
				token: limitedToken,
				email: userEmail,
				role: role.id,
			});

			expect(user?.id).toBeDefined();
			userIds[vendor] = user.id;

			const createPerm = await request(getUrl(vendor))
				.post('/permissions')
				.set('Authorization', admin)
				.send({ role: role.id, collection: 'directus_folders', action: 'create', fields: ['name', 'parent'] });

			expect(createPerm.statusCode).toBe(200);

			const readPerm = await request(getUrl(vendor))
				.post('/permissions')
				.set('Authorization', admin)
				.send({ role: role.id, collection: 'directus_folders', action: 'read', fields: ['*'] });

			expect(readPerm.statusCode).toBe(200);
		}
	});

	afterAll(async () => {
		const failures: string[] = [];

		for (const vendor of vendors) {
			for (const id of createdFileIds[vendor] ?? []) await safeDelete(vendor, `/files/${id}`, failures);
			for (const id of createdFolderIds[vendor] ?? []) await safeDelete(vendor, `/folders/${id}`, failures);
			if (userIds[vendor]) await safeDelete(vendor, `/users/${userIds[vendor]}`, failures);
			if (roleIds[vendor]) await safeDelete(vendor, `/roles/${roleIds[vendor]}`, failures);
		}

		if (failures.length > 0) throw new Error(`Fixture cleanup failed: ${failures.join('; ')}`);
	});

	it.each(vendors)('generates a key from the name when none is supplied (%s)', async (vendor) => {
		const response = await createFolder(vendor, { name: `Keygen ${run}` });

		expect(response.statusCode).toBe(200);
		expect(response.body.data.key).toBe(`keygen_${run}`);
	});

	it.each(vendors)('keeps a valid supplied key (%s)', async (vendor) => {
		const response = await createFolder(vendor, { name: 'Supplied Key', key: `valid_${run}` });

		expect(response.statusCode).toBe(200);
		expect(response.body.data.key).toBe(`valid_${run}`);
	});

	it.each(vendors)('refuses a malformed supplied key on create with INVALID_PAYLOAD (%s)', async (vendor) => {
		const response = await createFolder(vendor, { name: 'Malformed', key: 'Bad Key' });

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
	});

	it.each(vendors)('refuses a direct key change and allows an unchanged resubmit (%s)', async (vendor) => {
		const created = await createFolder(vendor, { name: 'Immutable Direct', key: `immutable_${run}` });
		expect(created.statusCode).toBe(200);
		const id = created.body.data.id;

		const change = await request(getUrl(vendor))
			.patch(`/folders/${id}`)
			.set('Authorization', admin)
			.send({ key: `changed_${run}` });

		expect(change.statusCode).toBe(400);
		expect(change.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');

		const resubmit = await request(getUrl(vendor))
			.patch(`/folders/${id}`)
			.set('Authorization', admin)
			.send({ key: `immutable_${run}`, name: 'Renamed Directly' });

		expect(resubmit.statusCode).toBe(200);

		const after = await request(getUrl(vendor)).get(`/folders/${id}`).set('Authorization', admin);

		expect(after.statusCode).toBe(200);
		expect(after.body.data).toMatchObject({ key: `immutable_${run}`, name: 'Renamed Directly' });
	});

	it.each(vendors)('renames a folder through a nested file write while the key stays fixed (%s)', async (vendor) => {
		const folder = await createFolder(vendor, { name: 'Nested Target', key: `nested_${run}` });
		expect(folder.statusCode).toBe(200);
		const folderId = folder.body.data.id;

		const file = await createFile(vendor, folderId);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const rename = await request(getUrl(vendor))
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ folder: { id: folderId, name: 'Nested Renamed' } });

		expect(rename.statusCode).toBe(200);

		const after = await request(getUrl(vendor)).get(`/folders/${folderId}`).set('Authorization', admin);

		expect(after.statusCode).toBe(200);
		expect(after.body.data).toMatchObject({ name: 'Nested Renamed', key: `nested_${run}` });
	});

	it.each(vendors)('rolls back the whole write when a nested file write changes a key (%s)', async (vendor) => {
		const folder = await createFolder(vendor, { name: 'Nested Immutable', key: `nestedimm_${run}` });
		expect(folder.statusCode).toBe(200);
		const folderId = folder.body.data.id;

		const file = await createFile(vendor, folderId);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const fileBefore = await request(getUrl(vendor)).get(`/files/${fileId}`).set('Authorization', admin);
		expect(fileBefore.statusCode).toBe(200);

		const attempt = await request(getUrl(vendor))
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ title: 'Should Not Persist', folder: { id: folderId, key: `nestedchanged_${run}` } });

		expect(attempt.statusCode).toBe(400);
		expect(attempt.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');

		const fileAfter = await request(getUrl(vendor)).get(`/files/${fileId}`).set('Authorization', admin);
		expect(fileAfter.statusCode).toBe(200);
		expect(fileAfter.body.data.title).toBe(fileBefore.body.data.title);

		const folderAfter = await request(getUrl(vendor)).get(`/folders/${folderId}`).set('Authorization', admin);
		expect(folderAfter.statusCode).toBe(200);
		expect(folderAfter.body.data.key).toBe(`nestedimm_${run}`);
	});

	it.each(vendors)('creates a folder through a nested file write and generates its key (%s)', async (vendor) => {
		const seed = await createFolder(vendor, { name: 'Nested Create Seed', key: `createseed_${run}` });
		expect(seed.statusCode).toBe(200);

		const file = await createFile(vendor, seed.body.data.id);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const newFolderId = randomUUID();
		track(createdFolderIds, vendor, newFolderId);

		const created = await request(getUrl(vendor))
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ folder: { id: newFolderId, name: `Nested Created ${run}` } });

		expect(created.statusCode).toBe(200);

		const folder = await request(getUrl(vendor)).get(`/folders/${newFolderId}`).set('Authorization', admin);

		expect(folder.statusCode).toBe(200);
		expect(folder.body.data.key).toBe(`nested_created_${run}`);
	});

	it.each(vendors)('refuses a nested folder create that supplies an id but no name (%s)', async (vendor) => {
		const seed = await createFolder(vendor, { name: 'Missing Name Seed', key: `missingseed_${run}` });
		expect(seed.statusCode).toBe(200);

		const file = await createFile(vendor, seed.body.data.id);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const attemptedId = randomUUID();
		track(createdFolderIds, vendor, attemptedId);

		const attempt = await request(getUrl(vendor))
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ folder: { id: attemptedId } });

		expect(attempt.statusCode).toBe(400);

		const check = await request(getUrl(vendor))
			.get('/folders')
			.set('Authorization', admin)
			.query({ filter: { id: { _eq: attemptedId } } });

		expect(check.statusCode).toBe(200);
		expect(check.body.data).toHaveLength(0);
	});

	it.each(vendors)(
		'lets a creator without key permission create a folder and receive a generated key (%s)',
		async (vendor) => {
			const response = await request(getUrl(vendor))
				.post('/folders')
				.set('Authorization', `Bearer ${limitedToken}`)
				.send({ name: `Restricted ${run}` });

			track(createdFolderIds, vendor, response.body?.data?.id);

			expect(response.statusCode).toBe(200);
			expect(response.body.data.key).toBe(`restricted_${run}`);
		}
	);

	it.each(vendors)('refuses a creator who explicitly supplies an unpermitted key (%s)', async (vendor) => {
		const response = await request(getUrl(vendor))
			.post('/folders')
			.set('Authorization', `Bearer ${limitedToken}`)
			.send({ name: 'Restricted With Key', key: `sneaky_${run}` });

		track(createdFolderIds, vendor, response.body?.data?.id);

		expect(response.statusCode).toBe(403);

		const check = await request(getUrl(vendor))
			.get('/folders')
			.set('Authorization', admin)
			.query({ filter: { key: { _eq: `sneaky_${run}` } } });

		expect(check.statusCode).toBe(200);
		expect(check.body.data).toHaveLength(0);
	});
});
