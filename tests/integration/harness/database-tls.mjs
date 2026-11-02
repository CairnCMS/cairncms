import { isIP } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { databaseVendors } from './database-vendors.mjs';

const resources = new WeakMap();

export async function createTlsCertificates(directory, host, run) {
	const path = (name) => join(directory, name);

	const authority = async (name) =>
		run([
			'req',
			'-x509',
			'-newkey',
			'rsa:2048',
			'-nodes',
			'-keyout',
			path(`${name}.key`),
			'-out',
			path(`${name}.pem`),
			'-days',
			'2',
			'-subj',
			`/CN=Integration ${name}`,
		]);

	await authority('ca');
	await authority('untrusted');

	await run([
		'req',
		'-new',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		path('server.key'),
		'-out',
		path('server.csr'),
		'-subj',
		'/CN=Integration database',
	]);

	const name = isIP(host) ? `IP:${host}` : `DNS:${host}`;

	for (const [certificate, san] of [
		['server', name],
		['mismatch', 'DNS:mismatch.invalid'],
	]) {
		await writeFile(path(`${certificate}.extensions`), `subjectAltName=${san}\nextendedKeyUsage=serverAuth\n`);

		await run([
			'x509',
			'-req',
			'-in',
			path('server.csr'),
			'-CA',
			path('ca.pem'),
			'-CAkey',
			path('ca.key'),
			'-CAcreateserial',
			'-out',
			path(`${certificate}.pem`),
			'-days',
			'2',
			'-extfile',
			path(`${certificate}.extensions`),
		]);
	}

	return {
		directory,
		ca: await readFile(path('ca.pem'), 'utf8'),
		untrusted: await readFile(path('untrusted.pem'), 'utf8'),
	};
}

export function tlsServiceDefinition(vendor, certificates, mismatch = false) {
	const definition = databaseVendors[vendor];
	if (!definition?.image) throw new Error(`Database TLS requires a server vendor: ${vendor}`);
	const postgres = definition.family === 'postgres';
	const user = postgres ? 'postgres' : 'mysql';

	const command = postgres
		? [
				'postgres',
				'-c',
				'ssl=on',
				'-c',
				'ssl_cert_file=/tmp/tls/server.pem',
				'-c',
				'ssl_key_file=/tmp/tls/server.key',
				'-c',
				'hba_file=/tmp/tls/pg_hba.conf',
		  ]
		: [
				definition.family === 'maria' ? 'mariadbd' : 'mysqld',
				...definition.command,
				'--ssl-ca=/tmp/tls/ca.pem',
				'--ssl-cert=/tmp/tls/server.pem',
				'--ssl-key=/tmp/tls/server.key',
				'--require-secure-transport=ON',
		  ];

	return {
		name: `database-tls-${vendor}`,
		image: definition.image,
		port: definition.port,
		environment: definition.environment,
		command,
		entrypoint: [
			'/bin/sh',
			'-c',
			`chown ${user}:${user} /tmp/tls/server.key /tmp/tls/server.pem /tmp/tls/ca.pem && chmod 600 /tmp/tls/server.key && exec docker-entrypoint.sh "$@"`,
			'tls-entry',
		],
		files: [
			{ source: join(certificates.directory, 'server.key'), target: '/tmp/tls/server.key', mode: 0o600 },
			{
				source: join(certificates.directory, mismatch ? 'mismatch.pem' : 'server.pem'),
				target: '/tmp/tls/server.pem',
				mode: 0o644,
			},
			{ source: join(certificates.directory, 'ca.pem'), target: '/tmp/tls/ca.pem', mode: 0o644 },
		],
		contents: postgres
			? [
					{
						target: '/tmp/tls/pg_hba.conf',
						mode: 0o644,
						content:
							'local all all trust\nhostnossl all all 0.0.0.0/0 reject\nhostnossl all all ::/0 reject\nhostssl all all 0.0.0.0/0 md5\nhostssl all all ::/0 md5\n',
					},
			  ]
			: [],
		health: definition.health,
		startupTimeoutMs: 90000,
	};
}

export function registerTlsResource(resource, details) {
	resources.set(resource, details);
	return resource;
}

export function tlsResourceDetails(resource, runtime) {
	const details = resources.get(resource);
	if (!details || details.vendor !== runtime.vendor || details.reports !== runtime.directory)
		throw new Error('TLS database resource does not belong to this vendor run');
	if (!details.available()) throw new Error('Owned TLS database stopped');
	return details;
}

export function tlsEnvironment(details, environment, profile = 'verified') {
	const env = { ...environment };
	for (const key of Object.keys(env)) if (key.startsWith('DB_SSL') || key === 'DB_CONNECTION_STRING') delete env[key];
	const postgres = databaseVendors[details.vendor].family === 'postgres';
	if (profile === 'plaintext') return env;

	if (profile === 'connection-string' || profile === 'connection-string-wrong-ca') {
		if (!postgres) throw new Error('TLS connection-string profile requires PostgreSQL');
		const url = new URL('postgresql://localhost');
		url.hostname = isIP(env.DB_HOST) === 6 ? `[${env.DB_HOST}]` : env.DB_HOST;
		url.port = env.DB_PORT;
		url.username = env.DB_USER;
		url.password = env.DB_PASSWORD;
		url.pathname = `/${encodeURIComponent(env.DB_DATABASE)}`;
		url.searchParams.set('sslmode', 'verify-full');

		url.searchParams.set(
			'sslrootcert',
			join(details.certificates.directory, profile.endsWith('wrong-ca') ? 'untrusted.pem' : 'ca.pem')
		);

		env.DB_CONNECTION_STRING = url.href;
		for (const key of ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASSWORD', 'DB_DATABASE']) delete env[key];
		return env;
	}

	if (!['verified', 'ca-file', 'wrong-ca', 'verification-disabled', 'wrong-password'].includes(profile))
		throw new Error(`Unknown database TLS profile: ${profile}`);
	if (profile === 'ca-file') env.DB_SSL__CA_FILE = join(details.certificates.directory, 'ca.pem');
	else env.DB_SSL__CA = profile === 'wrong-ca' ? details.certificates.untrusted : details.certificates.ca;
	const disabled = profile === 'verification-disabled';
	env.DB_SSL__REJECT_UNAUTHORIZED = String(!disabled || !postgres);
	if (!postgres) env.DB_SSL__VERIFY_IDENTITY = String(!disabled);
	if (profile === 'wrong-password') env.DB_PASSWORD = 'incorrect-password';
	return env;
}
