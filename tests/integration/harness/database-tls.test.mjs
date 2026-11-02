import { test } from 'node:test';
import assert from 'node:assert/strict';
import { databaseVendors } from './database-vendors.mjs';
import { tlsServiceDefinition, tlsEnvironment, registerTlsResource, tlsResourceDetails } from './database-tls.mjs';

test('TLS database resources cannot be borrowed from another run or used after release', () => {
	let available = true;
	const runtime = { vendor: 'postgres18', directory: '/reports/a' };

	const resource = registerTlsResource(
		{},
		{ vendor: runtime.vendor, reports: runtime.directory, available: () => available }
	);

	assert(tlsResourceDetails(resource, runtime));
	assert.throws(() => tlsResourceDetails({}, runtime), /does not belong/);
	assert.throws(() => tlsResourceDetails(resource, { ...runtime, directory: '/reports/b' }), /does not belong/);
	assert.throws(() => tlsResourceDetails(resource, { ...runtime, vendor: 'mysql84' }), /does not belong/);
	available = false;
	assert.throws(() => tlsResourceDetails(resource, runtime), /stopped/);
});

test('verified TLS profiles remove competing settings without changing the owned endpoint', () => {
	const details = {
		vendor: 'mysql84',
		certificates: { directory: '/certificates', ca: 'trusted', untrusted: 'other' },
	};

	const env = {
		DB_HOST: 'localhost',
		DB_PORT: '1234',
		DB_USER: 'test',
		DB_PASSWORD: 'secret',
		DB_DATABASE: 'db',
		DB_SSL__CA_FILE: 'old',
		DB_CONNECTION_STRING: 'unowned',
	};

	const configured = tlsEnvironment(details, env);
	assert.equal(configured.DB_HOST, env.DB_HOST);
	assert.equal(configured.DB_SSL__VERIFY_IDENTITY, 'true');
	assert.equal(configured.DB_SSL__REJECT_UNAUTHORIZED, 'true');
	assert.equal(configured.DB_SSL__CA, 'trusted');
	assert.equal(configured.DB_SSL__CA_FILE, undefined);
	assert.equal(configured.DB_CONNECTION_STRING, undefined);
	assert.equal(env.DB_CONNECTION_STRING, 'unowned');
	assert.equal(tlsEnvironment(details, env, 'plaintext').DB_SSL__CA_FILE, undefined);
	assert.throws(() => tlsEnvironment(details, env, 'connection-string'), /PostgreSQL/);
	assert.throws(() => tlsEnvironment(details, env, 'unknown'), /Unknown/);
});

test('connection strings encode owned values and cannot inherit an SSL bypass', () => {
	const details = { vendor: 'postgres18', certificates: { directory: '/certificates with space', ca: 'trusted' } };

	const env = {
		DB_HOST: 'localhost',
		DB_PORT: '1234',
		DB_USER: 'test@user',
		DB_PASSWORD: 'p@ss:/?&',
		DB_DATABASE: 'test db',
		DB_SSL__REJECT_UNAUTHORIZED: 'false',
	};

	const configured = tlsEnvironment(details, env, 'connection-string');
	const url = new URL(configured.DB_CONNECTION_STRING);
	assert.equal(decodeURIComponent(url.username), env.DB_USER);
	assert.equal(decodeURIComponent(url.password), env.DB_PASSWORD);
	assert.equal(decodeURIComponent(url.pathname), '/test db');
	assert.equal(url.searchParams.get('sslmode'), 'verify-full');
	assert.equal(url.searchParams.get('sslrootcert'), '/certificates with space/ca.pem');
	assert.equal(configured.DB_SSL__REJECT_UNAUTHORIZED, undefined);
	assert.equal(configured.DB_HOST, undefined);

	assert.equal(
		new URL(tlsEnvironment(details, { ...env, DB_HOST: '::1' }, 'connection-string').DB_CONNECTION_STRING).hostname,
		'[::1]'
	);
});

test('TLS service configuration preserves engine pins and enables encryption on each server family', () => {
	for (const [vendor, definition] of Object.entries(databaseVendors)) {
		if (!definition.image) continue;
		const service = tlsServiceDefinition(vendor, { directory: '/certificates' });
		assert.equal(service.image, definition.image);
		assert.equal(service.port, definition.port);
		assert.equal(service.files.find((file) => file.target.endsWith('server.key')).mode, 0o600);

		if (definition.family === 'postgres') assert.match(service.contents[0].content, /hostnossl all all .* reject/);
		else {
			assert(service.command.includes('--require-secure-transport=ON'));
			assert.equal(service.command[0], definition.family === 'maria' ? 'mariadbd' : 'mysqld');
		}
	}

	assert.throws(() => tlsServiceDefinition('sqlite3', {}), /server vendor/);
});
