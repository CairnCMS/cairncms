import { expect, inject } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import { createDatabaseTlsTest, withDatabaseTls, type DatabaseTls } from '../../fixtures/database-tls';
import { createEnvironmentTest } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import request from '../../fixtures/request';
import { CreateCollection, CreateFieldM2O } from '../../fixtures/schema';
import { familyOf } from '../../harness/database-vendors.mjs';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createDatabaseTlsTest();

const identityTest = createEnvironmentTest().extend<{ identityTlsState: Prerequisite<DatabaseTls> }>({
	identityTlsState: [
		async ({ cancellationSignal, teardownFailures }, use) => {
			await capturePrerequisite(
				(ready) => withDatabaseTls(inject('integration'), cancellationSignal, ready, { mismatch: true }),
				use,
				teardownFailures
			);
		},
		{ scope: 'file', auto: true },
	],
});

describeForVendors('Database TLS', ['postgres', 'mysql', 'maria'], 'SQLite has no network database connection', () => {
	test('authenticates and persists related records with a trusted inline CA', async ({ api, tls }) => {
		expect(tls.requiresEncryption).toBe(true);

		const login = await request(api.url)
			.post('/auth/login')
			.send({ email: 'bootstrap@example.com', password: 'BootstrapPassword123' })
			.expect(200);

		expect(login.body.data.access_token).toBeTypeOf('string');
		const token = login.body.data.access_token;
		const currentUser = await request(api.url).get('/users/me').auth(token, { type: 'bearer' }).expect(200);
		expect(currentUser.body.data.email).toBe('bootstrap@example.com');

		await CreateCollection(api, {
			collection: 'test_tls_authors',
			fields: [{ field: 'name', type: 'string' }],
		});

		await CreateCollection(api, {
			collection: 'test_tls_articles',
			fields: [{ field: 'title', type: 'string' }],
		});

		await CreateFieldM2O(api, {
			collection: 'test_tls_articles',
			field: 'author',
			otherCollection: 'test_tls_authors',
		});

		const created = await request(api.url)
			.post('/items/test_tls_articles')
			.auth(token, { type: 'bearer' })
			.send({ title: 'Encrypted draft', author: { name: 'TLS author' } })
			.expect(200);

		expect(created.body.data.id).toBeTypeOf('number');
		expect(created.body.data.author).toBeTypeOf('number');
		const articleId = created.body.data.id;
		const authorId = created.body.data.author;

		const read = await request(api.url)
			.get(`/items/test_tls_articles/${articleId}`)
			.auth(token, { type: 'bearer' })
			.query({ fields: 'id,title,author.id,author.name' })
			.expect(200);

		expect(read.body.data).toEqual({
			id: articleId,
			title: 'Encrypted draft',
			author: { id: authorId, name: 'TLS author' },
		});

		await request(api.url)
			.patch(`/items/test_tls_articles/${articleId}`)
			.auth(token, { type: 'bearer' })
			.send({ title: 'Encrypted revision', author: { id: authorId, name: 'Updated TLS author' } })
			.expect(200);

		const updated = await request(api.url)
			.get(`/items/test_tls_articles/${articleId}`)
			.auth(token, { type: 'bearer' })
			.query({ fields: 'id,title,author.id,author.name' })
			.expect(200);

		expect(updated.body.data).toEqual({
			id: articleId,
			title: 'Encrypted revision',
			author: { id: authorId, name: 'Updated TLS author' },
		});
	});

	test('loads a trusted CA from DB_SSL__CA_FILE', async ({ tls }) => {
		expect(await tls.probe('ca-file')).toMatchObject({ ok: true, encrypted: true, value: 42 });
	});

	test('rejects an untrusted CA', async ({ tls }) => {
		const result = await tls.probe('wrong-ca');
		expect(result.ok).toBe(false);
		expect(result.error?.message).toMatch(/certificate/i);
	});

	identityTest('rejects a trusted certificate for the wrong server name', async ({ identityTlsState, task, skip }) => {
		const tls = requirePrerequisite(identityTlsState, 'TLS database with a mismatched certificate', { task, skip });
		const result = await tls.probe();
		expect(result.ok).toBe(false);
		expect(result.error?.message).toMatch(/altnames/);
	});

	test('rejects plaintext when the server requires TLS', async ({ tls, vendor }) => {
		expect(tls.requiresEncryption).toBe(true);
		// MariaDB reports plaintext refusal as access denied. Prove these same credentials work over TLS.
		expect(await tls.probe()).toMatchObject({ ok: true, encrypted: true, value: 42 });
		const result = await tls.probe('plaintext');
		expect(result.ok).toBe(false);

		if (familyOf(vendor) === 'postgres') {
			expect(result.error?.code).toBe('28000');
			expect(result.error?.message).toMatch(/no encryption|SSL off/);
		} else {
			expect(['ER_SECURE_TRANSPORT_REQUIRED', 'ER_ACCESS_DENIED_ERROR']).toContain(result.error?.code);
		}
	});
});

describeForVendors(
	'Database TLS connection string',
	['postgres'],
	'sslmode and sslrootcert are PostgreSQL options',
	() => {
		test('verifies TLS using DB_CONNECTION_STRING', async ({ tls }) => {
			expect(await tls.probe('connection-string')).toMatchObject({ ok: true, encrypted: true, value: 42 });
		});
	}
);
