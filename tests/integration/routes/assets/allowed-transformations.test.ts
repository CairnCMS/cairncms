import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type supertest from 'supertest';
import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, USER } from '../../fixtures/identities';
import request, { CreateItem, setupRequest } from '../../fixtures/request';
import { CreateCollection, CreateFieldM2O } from '../../fixtures/schema';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createIdentityTest();

initializeFixtures();

const imageFilePath = fileURLToPath(new URL('../../fixtures/assets/directus.png', import.meta.url));

const thumbPreset = {
	key: 'project-thumb',
	fit: 'cover',
	width: 100,
	height: 100,
	quality: null,
	withoutEnlargement: null,
	format: null,
	transforms: [],
};

function pngSize(buffer: Buffer): { width: number; height: number } {
	return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Runs a case under one transformation mode against a fresh upload, then restores the settings and removes the file. */
async function withTransformMode(
	api: Api,
	mode: 'all' | 'presets' | 'none',
	run: (get: (query: string) => Promise<supertest.Response>) => Promise<void>
) {
	const auth = `Bearer ${api.adminToken}`;

	const before = await setupRequest(api.url)
		.get('/settings?fields=storage_asset_transform,storage_asset_presets')
		.set('Authorization', auth);

	const original = {
		storage_asset_transform: before.body.data.storage_asset_transform ?? null,
		storage_asset_presets: before.body.data.storage_asset_presets ?? null,
	};

	const cleanup: { fileDelete?: number; settingsRestore?: number } = {};
	let fileId: string | undefined;

	try {
		await setupRequest(api.url)
			.patch('/settings')
			.set('Authorization', auth)
			.send({ storage_asset_transform: mode, storage_asset_presets: [thumbPreset] });

		const upload = await setupRequest(api.url)
			.post('/files')
			.set('Authorization', auth)
			.field('storage', 'local')
			.attach('file', createReadStream(imageFilePath));

		fileId = upload.body.data.id;

		await run((query) => request(api.url).get(`/assets/${fileId}${query}`).set('Authorization', auth));
	} finally {
		if (fileId) {
			cleanup.fileDelete = (await request(api.url).delete(`/files/${fileId}`).set('Authorization', auth)).statusCode;
		}

		cleanup.settingsRestore = (
			await request(api.url).patch('/settings').set('Authorization', auth).send(original)
		).statusCode;
	}

	expect([200, 204]).toContain(cleanup.fileDelete);
	expect(cleanup.settingsRestore).toBe(200);
}

describe('/assets allowed transformations with an empty transforms list', () => {
	test('limiting to presets rejects resize parameters that carry an empty transforms list', async ({ api }) => {
		await withTransformMode(api, 'presets', async (get) => {
			const bypass = await get('?width=100&transforms=[]');
			expect(bypass.statusCode).toBe(400);
			expect(bypass.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const resize = await get('?width=100');
			expect(resize.statusCode).toBe(400);

			const original = await get('');
			const emptyList = await get('?transforms=[]');
			expect(original.statusCode).toBe(200);
			expect(emptyList.statusCode).toBe(200);
			expect(Buffer.compare(emptyList.body, original.body)).toBe(0);

			const preset = await get(`?key=${thumbPreset.key}`);
			expect(preset.statusCode).toBe(200);
			expect(pngSize(preset.body)).toEqual({ width: 100, height: 100 });
		});
	});

	test('disabling transformations rejects resize parameters that carry an empty transforms list', async ({ api }) => {
		await withTransformMode(api, 'none', async (get) => {
			const bypass = await get('?width=100&transforms=[]');
			expect(bypass.statusCode).toBe(400);
			expect(bypass.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const projectPreset = await get(`?key=${thumbPreset.key}`);
			expect(projectPreset.statusCode).toBe(400);

			const systemSize = await get('?key=system-small-cover');
			expect(systemSize.statusCode).toBe(200);
			expect(pngSize(systemSize.body)).toEqual({ width: 64, height: 64 });

			const original = await get('');
			const emptyList = await get('?transforms=[]');
			expect(emptyList.statusCode).toBe(200);
			expect(Buffer.compare(emptyList.body, original.body)).toBe(0);
		});
	});

	test('allowing all transformations still resizes with an empty transforms list', async ({ api }) => {
		await withTransformMode(api, 'all', async (get) => {
			const resized = await get('?width=100&transforms=[]');
			expect(resized.statusCode).toBe(200);
			expect(pngSize(resized.body).width).toBe(100);
		});
	});
});

describe('/assets built-in keys', () => {
	test('serve the Kanban card and avatar sizes in every transformation mode', async ({ api }) => {
		for (const mode of ['all', 'presets', 'none'] as const) {
			await withTransformMode(api, mode, async (get) => {
				const card = await get('?key=system-kanban-cover');
				expect(card.statusCode).toBe(200);
				expect(pngSize(card.body)).toEqual({ width: 250, height: 150 });

				const avatar = await get('?key=system-small-cover');
				expect(avatar.statusCode).toBe(200);
				expect(pngSize(avatar.body)).toEqual({ width: 64, height: 64 });
			});
		}
	});
});

const PUBLIC_TITLE = 'Public asset image';
const BLUR = `transforms=${encodeURIComponent(JSON.stringify([['blur', 1]]))}`;
const SOURCE_SIZE = { width: 930, height: 200 };

type AccessFixture = {
	publicFile: string;
	privateFile: string;
	unrelatedFile: string;
	asset: (fileId: string, query: string) => supertest.Test;
	shareToken: (fileId: string) => Promise<string>;
};

async function login(api: Api, email: string, password: string) {
	const response = await setupRequest(api.url).post('/auth/login').send({ email, password });
	return response.body.data as { access_token: string; refresh_token: string };
}

/**
 * Runs a case against a publicly readable file and two private files. The public role reads only the public file, and
 * the API-only role, which has no app access, reads all three. Settings are restored, and created permissions, shares,
 * collections, and files are removed.
 */
async function withAccessFixture(
	api: Api,
	settings: { mode: 'all' | 'presets' | 'none'; publicTransforms: boolean },
	run: (fixture: AccessFixture) => Promise<void>
) {
	const admin = `Bearer ${api.adminToken}`;

	const before = await setupRequest(api.url)
		.get('/settings?fields=storage_asset_transform,storage_asset_public_transforms,storage_asset_presets')
		.set('Authorization', admin);

	const original = {
		storage_asset_transform: before.body.data.storage_asset_transform ?? null,
		storage_asset_public_transforms: before.body.data.storage_asset_public_transforms ?? false,
		storage_asset_presets: before.body.data.storage_asset_presets ?? null,
	};

	const publicRole = (
		await setupRequest(api.url)
			.get('/roles')
			.query({ filter: JSON.stringify({ key: { _eq: 'public' } }), fields: 'id' })
			.set('Authorization', admin)
	).body.data[0].id as string;

	const apiOnlyRole = (
		await setupRequest(api.url)
			.get('/users')
			.query({ filter: JSON.stringify({ email: { _eq: USER['API_ONLY']!.EMAIL } }), fields: 'role' })
			.set('Authorization', admin)
	).body.data[0].role as string;

	const created = {
		permissions: [] as string[],
		files: [] as string[],
		shares: [] as string[],
		collections: [] as string[],
	};

	const cleanup: number[] = [];

	try {
		for (const permission of [
			{ role: publicRole, permissions: { title: { _eq: PUBLIC_TITLE } } },
			{ role: apiOnlyRole, permissions: {} },
		]) {
			const response = await setupRequest(api.url)
				.post('/permissions')
				.set('Authorization', admin)
				.send({ ...permission, collection: 'directus_files', action: 'read', fields: ['*'] });

			created.permissions.push(response.body.data.id);
		}

		const upload = async (title: string) => {
			const response = await setupRequest(api.url)
				.post('/files')
				.set('Authorization', admin)
				.field('storage', 'local')
				.field('title', title)
				.attach('file', createReadStream(imageFilePath));

			created.files.push(response.body.data.id);
			return response.body.data.id as string;
		};

		const publicFile = await upload(PUBLIC_TITLE);
		const privateFile = await upload('Private asset image');
		const unrelatedFile = await upload('Unrelated private asset image');

		await setupRequest(api.url)
			.patch('/settings')
			.set('Authorization', admin)
			.send({
				storage_asset_transform: settings.mode,
				storage_asset_public_transforms: settings.publicTransforms,
				storage_asset_presets: [thumbPreset],
			});

		// A share reaches a file only through a shared item that references it, and only for collections its role can read.
		const shareToken = async (fileId: string) => {
			const collection = `asset_share_${randomUUID().slice(0, 8)}`;

			await CreateCollection(api, { collection, primaryKeyType: 'integer' });
			created.collections.push(collection);

			await CreateFieldM2O(api, {
				collection,
				field: 'image',
				otherCollection: 'directus_files',
				primaryKeyType: 'uuid',
			});

			const permission = await setupRequest(api.url)
				.post('/permissions')
				.set('Authorization', admin)
				.send({ role: apiOnlyRole, collection, action: 'read', fields: ['*'] });

			created.permissions.push(permission.body.data.id);

			const item = await CreateItem(api, { collection, item: { image: fileId } });

			const share = await setupRequest(api.url)
				.post('/shares')
				.set('Authorization', admin)
				.send({ collection, item: item.id, role: apiOnlyRole, name: 'Asset share' });

			created.shares.push(share.body.data.id);

			const auth = await setupRequest(api.url).post('/shares/auth').send({ share: share.body.data.id });
			return auth.body.data.access_token as string;
		};

		await run({
			publicFile,
			privateFile,
			unrelatedFile,
			asset: (fileId, query) => request(api.url).get(`/assets/${fileId}${query}`),
			shareToken,
		});
	} finally {
		for (const id of created.shares) {
			cleanup.push((await request(api.url).delete(`/shares/${id}`).set('Authorization', admin)).statusCode);
		}

		for (const id of created.permissions) {
			cleanup.push((await request(api.url).delete(`/permissions/${id}`).set('Authorization', admin)).statusCode);
		}

		for (const collection of created.collections) {
			cleanup.push(
				(await request(api.url).delete(`/collections/${collection}`).set('Authorization', admin)).statusCode
			);
		}

		for (const id of created.files) {
			cleanup.push((await request(api.url).delete(`/files/${id}`).set('Authorization', admin)).statusCode);
		}

		cleanup.push((await request(api.url).patch('/settings').set('Authorization', admin).send(original)).statusCode);
	}

	for (const status of cleanup) expect([200, 204]).toContain(status);
}

describe('/assets advanced transformations', () => {
	test('need an authenticated user when public advanced transformations are off', async ({ api }) => {
		await withAccessFixture(api, { mode: 'all', publicTransforms: false }, async (fixture) => {
			const { publicFile, privateFile, asset, shareToken } = fixture;

			const anonymous = await asset(publicFile, `?${BLUR}`);
			expect(anonymous.statusCode).toBe(400);
			expect(anonymous.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const anonymousResize = await asset(publicFile, '?width=100');
			expect(anonymousResize.statusCode).toBe(200);
			expect(pngSize(anonymousResize.body).width).toBe(100);

			const anonymousPreset = await asset(publicFile, `?key=${thumbPreset.key}`);
			expect(anonymousPreset.statusCode).toBe(200);
			expect(pngSize(anonymousPreset.body)).toEqual({ width: 100, height: 100 });

			const original = await asset(publicFile, '');
			const anonymousEmptyList = await asset(publicFile, '?transforms=[]');
			expect(anonymousEmptyList.statusCode).toBe(200);
			expect(Buffer.compare(anonymousEmptyList.body, original.body)).toBe(0);

			const staticToken = await asset(privateFile, `?${BLUR}`).set(
				'Authorization',
				`Bearer ${USER['API_ONLY']!.TOKEN}`
			);

			expect(staticToken.statusCode).toBe(200);
			expect(pngSize(staticToken.body)).toEqual(SOURCE_SIZE);

			const tokens = await login(api, USER['API_ONLY']!.EMAIL, USER['API_ONLY']!.PASSWORD);

			const accessToken = await asset(privateFile, `?${BLUR}`).set('Authorization', `Bearer ${tokens.access_token}`);
			expect(accessToken.statusCode).toBe(200);

			const session = await asset(privateFile, `?${BLUR}`).set(
				'Cookie',
				`cairncms_refresh_token=${tokens.refresh_token}`
			);

			expect(session.statusCode).toBe(200);
			expect(pngSize(session.body)).toEqual(SOURCE_SIZE);

			const anonymousPrivate = await asset(privateFile, '?width=100');
			expect(anonymousPrivate.statusCode).toBe(403);

			const share = await shareToken(privateFile);

			const shareResize = await asset(privateFile, '?width=100').set('Authorization', `Bearer ${share}`);
			expect(shareResize.statusCode).toBe(200);
			expect(pngSize(shareResize.body).width).toBe(100);

			const shareAdvanced = await asset(privateFile, `?${BLUR}`).set('Authorization', `Bearer ${share}`);
			expect(shareAdvanced.statusCode).toBe(400);
			expect(shareAdvanced.body.errors[0].extensions.code).toBe('INVALID_QUERY');

			const withoutFilePermission = await asset(privateFile, `?${BLUR}`).set(
				'Authorization',
				`Bearer ${USER['APP_ACCESS']!.TOKEN}`
			);

			expect(withoutFilePermission.statusCode).toBe(403);
		});
	});

	test('follow file permissions when public advanced transformations are on', async ({ api }) => {
		await withAccessFixture(api, { mode: 'all', publicTransforms: true }, async (fixture) => {
			const { publicFile, privateFile, unrelatedFile, asset, shareToken } = fixture;

			const anonymousPublic = await asset(publicFile, `?${BLUR}`);
			expect(anonymousPublic.statusCode).toBe(200);
			expect(pngSize(anonymousPublic.body)).toEqual(SOURCE_SIZE);

			const anonymousPrivate = await asset(privateFile, `?${BLUR}`);
			expect(anonymousPrivate.statusCode).toBe(403);

			const share = await shareToken(privateFile);

			const shareAdvanced = await asset(privateFile, `?${BLUR}`).set('Authorization', `Bearer ${share}`);
			expect(shareAdvanced.statusCode).toBe(200);
			expect(pngSize(shareAdvanced.body)).toEqual(SOURCE_SIZE);

			const shareUnrelated = await asset(unrelatedFile, `?${BLUR}`).set('Authorization', `Bearer ${share}`);
			expect(shareUnrelated.statusCode).toBe(403);
		});
	});

	test('are rejected for every caller when transformations are limited to presets or disabled', async ({ api }) => {
		for (const mode of ['presets', 'none'] as const) {
			await withAccessFixture(api, { mode, publicTransforms: true }, async ({ privateFile, asset }) => {
				for (const token of [api.adminToken, USER['API_ONLY']!.TOKEN]) {
					const response = await asset(privateFile, `?${BLUR}`).set('Authorization', `Bearer ${token}`);
					expect(response.statusCode).toBe(400);
					expect(response.body.errors[0].extensions.code).toBe('INVALID_QUERY');
				}
			});
		}
	});
});
