import { expect, inject } from 'vitest';
import { createDatabaseTlsTest, withDatabaseTls, type DatabaseTls } from '../../fixtures/database-tls';
import { createEnvironmentTest } from '../../fixtures/environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { initializeFixtures } from '../fixture-setup.mjs';
import { familyOf } from '../database-vendors.mjs';
import request from '../../fixtures/request';

initializeFixtures();

const mode = process.env.CONTROL_DATABASE_TLS ?? 'healthy';

if (mode === 'identity') {
	const test = createEnvironmentTest().extend<{ tlsState: Prerequisite<DatabaseTls> }>({
		tlsState: [
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

	test('a trusted wrong-name certificate is rejected by the production connection', async ({
		tlsState,
		task,
		skip,
	}) => {
		const tls = requirePrerequisite(tlsState, 'TLS database', { task, skip });
		const result = await tls.probe();
		expect(result.ok).toBe(false);
		expect(result.error?.message).toMatch(/altnames/);
		expect((await tls.probe('verification-disabled')).ok).toBe(true);
	});
} else {
	const test = createDatabaseTlsTest();

	test('owned TLS resources bootstrap the API and preserve connection outcomes', async ({ api, tls, vendor }) => {
		if (mode === 'failure') throw new Error('TLS_CONTROL_FAILURE');
		await request(api.url).get('/server/ping').expect(200);
		expect(api.adminToken).toBeTypeOf('string');
		expect(tls.requiresEncryption).toBe(true);

		for (const profile of ['verified', 'ca-file'] as const) {
			const result = await tls.probe(profile);
			expect(result).toMatchObject({ ok: true, encrypted: true, value: 42 });
			expect(result.versions.knex).toBeTypeOf('string');
		}

		const wrongCa = await tls.probe('wrong-ca');
		expect(wrongCa.ok).toBe(false);
		expect(wrongCa.error?.message).toMatch(/certificate/i);
		const password = await tls.probe('wrong-password');
		expect(password.ok).toBe(false);
		expect(password.error?.code).toBe(familyOf(vendor) === 'postgres' ? '28P01' : 'ER_ACCESS_DENIED_ERROR');
		expect(password.error?.message).not.toMatch(/certificate|altnames/i);
		const plaintext = await tls.probe('plaintext');
		expect(plaintext.ok).toBe(false);

		if (familyOf(vendor) === 'postgres') {
			expect(plaintext.error?.code).toBe('28000');
			expect(plaintext.error?.message).toMatch(/no encryption|SSL off/);
			expect(await tls.probe('connection-string')).toMatchObject({ ok: true, encrypted: true, value: 42 });
			const untrustedString = await tls.probe('connection-string-wrong-ca');
			expect(untrustedString.ok).toBe(false);
			expect(untrustedString.error?.message).toMatch(/certificate/i);
		} else {
			expect(['ER_SECURE_TRANSPORT_REQUIRED', 'ER_ACCESS_DENIED_ERROR']).toContain(plaintext.error?.code);
		}
	});
}
