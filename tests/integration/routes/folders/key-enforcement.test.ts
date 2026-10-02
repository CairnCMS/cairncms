import { setupRequest } from '../../fixtures/request';
import { describe, expect, inject } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createScenarioTest } from '../../fixtures/scenario';
import * as common from '../../fixtures/data';
import { randomUUID } from 'crypto';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const vendor = inject('integration').vendor;

initializeFixtures();

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

async function createFolder(api: Api, body: Record<string, unknown>, expectedStatus = 200) {
	const response = await setupRequest(api.url)
		.post('/folders')
		.set('Authorization', admin)
		.send(body)
		.expect(expectedStatus);

	track(createdFolderIds, vendor, response.body?.data?.id);

	return response;
}

async function createFile(api: Api, folderId: string) {
	const response = await setupRequest(api.url)
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

async function safeDelete(api: Api, path: string, failures: string[]): Promise<void> {
	try {
		const response = await request(api.url).delete(path).set('Authorization', admin);

		// Deleting an absent key still returns 204 here, so any other status is a real cleanup failure.
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

		const role = await common.CreateRole(api, {
			name: roleName,
			appAccessEnabled: true,
			adminAccessEnabled: false,
		});

		expect(role?.id).toBeDefined();
		roleIds[vendor] = role.id;

		const user = await createUser(api, {
			token: limitedToken,
			email: userEmail,
			role: role.id,
		});

		expect(user?.id).toBeDefined();
		userIds[vendor] = user.id;

		const createPerm = await setupRequest(api.url)
			.post('/permissions')
			.set('Authorization', admin)
			.send({ role: role.id, collection: 'directus_folders', action: 'create', fields: ['name', 'parent'] });

		expect(createPerm.statusCode).toBe(200);

		const readPerm = await setupRequest(api.url)
			.post('/permissions')
			.set('Authorization', admin)
			.send({ role: role.id, collection: 'directus_folders', action: 'read', fields: ['*'] });

		expect(readPerm.statusCode).toBe(200);
	},
	cleanup: async (api, vendor) => {
		const failures: string[] = [];

		for (const id of createdFileIds[vendor] ?? []) await safeDelete(api, `/files/${id}`, failures);
		for (const id of createdFolderIds[vendor] ?? []) await safeDelete(api, `/folders/${id}`, failures);
		if (userIds[vendor]) await safeDelete(api, `/users/${userIds[vendor]}`, failures);
		if (roleIds[vendor]) await safeDelete(api, `/roles/${roleIds[vendor]}`, failures);

		if (failures.length > 0) throw new Error(`Fixture cleanup failed: ${failures.join('; ')}`);
	},
});

describe('folder key enforcement', () => {
	test('generates a key from the name when none is supplied', async ({ api }) => {
		const response = await createFolder(api, { name: `Keygen ${run}` });

		expect(response.statusCode).toBe(200);
		expect(response.body.data.key).toBe(`keygen_${run}`);
	});

	test('keeps a valid supplied key', async ({ api }) => {
		const response = await createFolder(api, { name: 'Supplied Key', key: `valid_${run}` });

		expect(response.statusCode).toBe(200);
		expect(response.body.data.key).toBe(`valid_${run}`);
	});

	test('refuses a malformed supplied key on create with INVALID_PAYLOAD', async ({ api }) => {
		const response = await createFolder(api, { name: 'Malformed', key: 'Bad Key' }, 400);

		expect(response.statusCode).toBe(400);
		expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
	});

	test('refuses a direct key change and allows an unchanged resubmit', async ({ api }) => {
		const created = await createFolder(api, { name: 'Immutable Direct', key: `immutable_${run}` });
		expect(created.statusCode).toBe(200);
		const id = created.body.data.id;

		const change = await request(api.url)
			.patch(`/folders/${id}`)
			.set('Authorization', admin)
			.send({ key: `changed_${run}` });

		expect(change.statusCode).toBe(400);
		expect(change.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');

		const resubmit = await request(api.url)
			.patch(`/folders/${id}`)
			.set('Authorization', admin)
			.send({ key: `immutable_${run}`, name: 'Renamed Directly' });

		expect(resubmit.statusCode).toBe(200);

		const after = await request(api.url).get(`/folders/${id}`).set('Authorization', admin);

		expect(after.statusCode).toBe(200);
		expect(after.body.data).toMatchObject({ key: `immutable_${run}`, name: 'Renamed Directly' });
	});

	test('renames a folder through a nested file write while the key stays fixed', async ({ api }) => {
		const folder = await createFolder(api, { name: 'Nested Target', key: `nested_${run}` });
		expect(folder.statusCode).toBe(200);
		const folderId = folder.body.data.id;

		const file = await createFile(api, folderId);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const rename = await request(api.url)
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ folder: { id: folderId, name: 'Nested Renamed' } });

		expect(rename.statusCode).toBe(200);

		const after = await request(api.url).get(`/folders/${folderId}`).set('Authorization', admin);

		expect(after.statusCode).toBe(200);
		expect(after.body.data).toMatchObject({ name: 'Nested Renamed', key: `nested_${run}` });
	});

	test('rolls back the whole write when a nested file write changes a key', async ({ api }) => {
		const folder = await createFolder(api, { name: 'Nested Immutable', key: `nestedimm_${run}` });
		expect(folder.statusCode).toBe(200);
		const folderId = folder.body.data.id;

		const file = await createFile(api, folderId);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const fileBefore = await request(api.url).get(`/files/${fileId}`).set('Authorization', admin);
		expect(fileBefore.statusCode).toBe(200);

		const attempt = await request(api.url)
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ title: 'Should Not Persist', folder: { id: folderId, key: `nestedchanged_${run}` } });

		expect(attempt.statusCode).toBe(400);
		expect(attempt.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');

		const fileAfter = await request(api.url).get(`/files/${fileId}`).set('Authorization', admin);
		expect(fileAfter.statusCode).toBe(200);
		expect(fileAfter.body.data.title).toBe(fileBefore.body.data.title);

		const folderAfter = await request(api.url).get(`/folders/${folderId}`).set('Authorization', admin);
		expect(folderAfter.statusCode).toBe(200);
		expect(folderAfter.body.data.key).toBe(`nestedimm_${run}`);
	});

	test('creates a folder through a nested file write and generates its key', async ({ api, vendor }) => {
		const seed = await createFolder(api, { name: 'Nested Create Seed', key: `createseed_${run}` });
		expect(seed.statusCode).toBe(200);

		const file = await createFile(api, seed.body.data.id);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const newFolderId = randomUUID();
		track(createdFolderIds, vendor, newFolderId);

		const created = await request(api.url)
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ folder: { id: newFolderId, name: `Nested Created ${run}` } });

		expect(created.statusCode).toBe(200);

		const folder = await request(api.url).get(`/folders/${newFolderId}`).set('Authorization', admin);

		expect(folder.statusCode).toBe(200);
		expect(folder.body.data.key).toBe(`nested_created_${run}`);
	});

	test('refuses a nested folder create that supplies an id but no name', async ({ api, vendor }) => {
		const seed = await createFolder(api, { name: 'Missing Name Seed', key: `missingseed_${run}` });
		expect(seed.statusCode).toBe(200);

		const file = await createFile(api, seed.body.data.id);
		expect(file.statusCode).toBe(200);
		const fileId = file.body.data.id;

		const attemptedId = randomUUID();
		track(createdFolderIds, vendor, attemptedId);

		const attempt = await request(api.url)
			.patch(`/files/${fileId}`)
			.set('Authorization', admin)
			.send({ folder: { id: attemptedId } });

		expect(attempt.statusCode).toBe(400);

		const check = await request(api.url)
			.get('/folders')
			.set('Authorization', admin)
			.query({ filter: { id: { _eq: attemptedId } } });

		expect(check.statusCode).toBe(200);
		expect(check.body.data).toHaveLength(0);
	});

	test('lets a creator without key permission create a folder and receive a generated key', async ({ api, vendor }) => {
		const response = await request(api.url)
			.post('/folders')
			.set('Authorization', `Bearer ${limitedToken}`)
			.send({ name: `Restricted ${run}` });

		track(createdFolderIds, vendor, response.body?.data?.id);

		expect(response.statusCode).toBe(200);
		expect(response.body.data.key).toBe(`restricted_${run}`);
	});

	test('refuses a creator who explicitly supplies an unpermitted key', async ({ api, vendor }) => {
		const response = await request(api.url)
			.post('/folders')
			.set('Authorization', `Bearer ${limitedToken}`)
			.send({ name: 'Restricted With Key', key: `sneaky_${run}` });

		track(createdFolderIds, vendor, response.body?.data?.id);

		expect(response.statusCode).toBe(403);

		const check = await request(api.url)
			.get('/folders')
			.set('Authorization', admin)
			.query({ filter: { key: { _eq: `sneaky_${run}` } } });

		expect(check.statusCode).toBe(200);
		expect(check.body.data).toHaveLength(0);
	});
});

async function createUser(api: Api, options: { token: string; email: string; role: string }) {
	const response = await setupRequest(api.url)
		.post('/users')
		.auth(api.adminToken, { type: 'bearer' })
		.send(options)
		.expect(200);

	return response.body.data;
}
