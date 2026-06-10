import { describe, expect, it } from 'vitest';
import { ExtensionCapabilitiesSchema, ExtensionManifest, ExtensionOptions } from './extensions.js';

describe('ExtensionCapabilitiesSchema', () => {
	it('accepts a brokered request plus log', () => {
		const result = ExtensionCapabilitiesSchema.safeParse({
			request: { methods: ['POST'], urls: ['https://api.github.com'] },
			log: true,
		});

		expect(result.success).toBe(true);
	});

	it('accepts a template capability', () => {
		expect(ExtensionCapabilitiesSchema.safeParse({ template: true }).success).toBe(true);
	});

	it('accepts an empty capability set', () => {
		expect(ExtensionCapabilitiesSchema.safeParse({}).success).toBe(true);
	});

	it('rejects unknown keys so raw powers cannot pose as capabilities', () => {
		expect(ExtensionCapabilitiesSchema.safeParse({ fs: true }).success).toBe(false);
		expect(ExtensionCapabilitiesSchema.safeParse({ env: true }).success).toBe(false);
	});

	it('requires at least one url for the request capability', () => {
		expect(ExtensionCapabilitiesSchema.safeParse({ request: { methods: ['POST'] } }).success).toBe(false);
	});

	it('rejects unknown keys inside the request capability', () => {
		expect(ExtensionCapabilitiesSchema.safeParse({ request: { urls: ['https://x'], surprise: true } }).success).toBe(
			false
		);
	});

	it('accepts origin-only request urls', () => {
		for (const url of [
			'https://api.example.com',
			'https://api.example.com/',
			'http://api.example.com',
			'https://api.example.com:8443',
		]) {
			expect(ExtensionCapabilitiesSchema.safeParse({ request: { urls: [url] } }).success, url).toBe(true);
		}
	});

	it('rejects request urls that are not a bare origin', () => {
		for (const url of [
			'https://api.example.com/safe',
			'https://api.example.com/**',
			'https://api.example.com/?q=1',
			'https://api.example.com/#frag',
			'https://user:pass@api.example.com',
			'ftp://api.example.com',
			'not a url',
		]) {
			expect(ExtensionCapabilitiesSchema.safeParse({ request: { urls: [url] } }).success, url).toBe(false);
		}
	});
});

const appOption = { host: '^1.1.0', type: 'interface', path: 'dist/index.js', source: 'src/index.js' };
const apiOption = { host: '^1.1.0', type: 'endpoint', path: 'dist/index.js', source: 'src/index.js' };

const hybridOption = {
	host: '^1.1.0',
	type: 'operation',
	path: { app: 'dist/app.js', api: 'dist/api.js' },
	source: { app: 'src/app.js', api: 'src/api.js' },
};

const bundleOption = {
	host: '^1.1.0',
	type: 'bundle',
	path: { app: 'dist/app.js', api: 'dist/api.js' },
	entries: [
		{ type: 'interface', name: 'my-interface', source: 'src/interface.js' },
		{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js' },
	],
};

const capabilities = { request: { methods: ['POST'], urls: ['https://api.github.com'] }, log: true };

describe('ExtensionOptions confined opt-in', () => {
	it('parses a plain manifest of every type', () => {
		expect(ExtensionOptions.safeParse(appOption).success).toBe(true);
		expect(ExtensionOptions.safeParse({ ...apiOption, type: 'hook' }).success).toBe(true);
		expect(ExtensionOptions.safeParse(apiOption).success).toBe(true);
		expect(ExtensionOptions.safeParse(hybridOption).success).toBe(true);
		expect(ExtensionOptions.safeParse(bundleOption).success).toBe(true);
	});

	it('accepts a confined-server declaration with capabilities on a server type', () => {
		expect(ExtensionOptions.safeParse({ ...apiOption, runtime: 'confined-server', capabilities }).success).toBe(true);

		expect(ExtensionOptions.safeParse({ ...hybridOption, runtime: 'confined-server', capabilities }).success).toBe(
			true
		);
	});

	it('accepts a confined-server server type without capabilities', () => {
		expect(ExtensionOptions.safeParse({ ...apiOption, runtime: 'confined-server' }).success).toBe(true);
	});

	it('rejects capabilities without runtime confined-server on a server type', () => {
		expect(ExtensionOptions.safeParse({ ...apiOption, capabilities }).success).toBe(false);
		expect(ExtensionOptions.safeParse({ ...hybridOption, capabilities }).success).toBe(false);
	});

	it('rejects a runtime or capabilities declaration on an app type', () => {
		expect(ExtensionOptions.safeParse({ ...appOption, runtime: 'confined-server' }).success).toBe(false);
		expect(ExtensionOptions.safeParse({ ...appOption, capabilities }).success).toBe(false);
	});

	it('rejects every runtime value that is not confined-server', () => {
		for (const runtime of ['full-authority-server', 'browser', 'config', 'external-service']) {
			expect(ExtensionOptions.safeParse({ ...apiOption, runtime }).success, runtime).toBe(false);
		}
	});

	it('rejects a malformed capabilities block', () => {
		expect(
			ExtensionOptions.safeParse({ ...apiOption, runtime: 'confined-server', capabilities: { fs: true } }).success
		).toBe(false);
	});
});

describe('ExtensionOptions confined bundle', () => {
	it('accepts a confined bundle with per-server-entry capabilities', () => {
		const result = ExtensionOptions.safeParse({
			...bundleOption,
			runtime: 'confined-server',
			entries: [
				{ type: 'interface', name: 'my-interface', source: 'src/interface.js' },
				{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js', capabilities },
			],
		});

		expect(result.success).toBe(true);
	});

	it('rejects a bundle entry that declares capabilities without a confined bundle runtime', () => {
		const result = ExtensionOptions.safeParse({
			...bundleOption,
			entries: [{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js', capabilities }],
		});

		expect(result.success).toBe(false);
	});

	it('rejects an app entry that declares capabilities', () => {
		const result = ExtensionOptions.safeParse({
			...bundleOption,
			runtime: 'confined-server',
			entries: [
				{ type: 'interface', name: 'my-interface', source: 'src/interface.js', capabilities },
				{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js' },
			],
		});

		expect(result.success).toBe(false);
	});

	it('rejects a runtime declared on a server entry instead of the bundle', () => {
		const endpointEntry = ExtensionOptions.safeParse({
			...bundleOption,
			entries: [{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js', runtime: 'confined-server' }],
		});

		const operationEntry = ExtensionOptions.safeParse({
			...bundleOption,
			entries: [
				{
					type: 'operation',
					name: 'my-operation',
					source: { app: 'src/app.js', api: 'src/api.js' },
					runtime: 'confined-server',
				},
			],
		});

		expect(endpointEntry.success).toBe(false);
		expect(operationEntry.success).toBe(false);
	});

	it('rejects a runtime declared on an app entry', () => {
		const result = ExtensionOptions.safeParse({
			...bundleOption,
			entries: [{ type: 'interface', name: 'my-interface', source: 'src/interface.js', runtime: 'confined-server' }],
		});

		expect(result.success).toBe(false);
	});

	it('rejects a confined bundle with no server entry', () => {
		const result = ExtensionOptions.safeParse({
			...bundleOption,
			runtime: 'confined-server',
			entries: [{ type: 'interface', name: 'my-interface', source: 'src/interface.js' }],
		});

		expect(result.success).toBe(false);
	});

	it('rejects capabilities declared at the bundle root', () => {
		const withoutRuntime = ExtensionOptions.safeParse({ ...bundleOption, capabilities });

		const withRuntime = ExtensionOptions.safeParse({
			...bundleOption,
			runtime: 'confined-server',
			capabilities,
			entries: [{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js' }],
		});

		expect(withoutRuntime.success).toBe(false);
		expect(withRuntime.success).toBe(false);
	});
});

describe('ExtensionManifest', () => {
	it('parses a plain package manifest', () => {
		const result = ExtensionManifest.safeParse({
			name: 'cairncms-extension-test',
			version: '1.0.0',
			'cairncms:extension': apiOption,
		});

		expect(result.success).toBe(true);
	});

	it('parses a confined package manifest', () => {
		const result = ExtensionManifest.safeParse({
			name: 'cairncms-extension-test',
			version: '1.0.0',
			'cairncms:extension': { ...apiOption, runtime: 'confined-server', capabilities },
		});

		expect(result.success).toBe(true);
	});
});
