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

	it('accepts optionDelivery on a confined operation and requires the confined runtime', () => {
		const optionDelivery = { apiKey: { delivery: 'reference' } };

		expect(ExtensionOptions.safeParse({ ...hybridOption, runtime: 'confined-server', optionDelivery }).success).toBe(
			true
		);

		expect(ExtensionOptions.safeParse({ ...hybridOption, optionDelivery }).success).toBe(false);
	});

	it('rejects a malformed option delivery shape', () => {
		const base = { ...hybridOption, runtime: 'confined-server' as const };

		expect(ExtensionOptions.safeParse({ ...base, optionDelivery: { apiKey: { delivery: 'raw' } } }).success).toBe(
			false
		);

		expect(ExtensionOptions.safeParse({ ...base, optionDelivery: { apiKey: { delivery: 'brokered' } } }).success).toBe(
			false
		);

		expect(ExtensionOptions.safeParse({ ...base, optionDelivery: { apiKey: 'reference' } }).success).toBe(false);

		expect(
			ExtensionOptions.safeParse({ ...base, optionDelivery: { apiKey: { delivery: 'reference', extra: true } } })
				.success
		).toBe(false);
	});

	it('rejects optionDelivery anywhere but a top-level operation rather than stripping it', () => {
		const optionDelivery = { apiKey: { delivery: 'reference' } };

		expect(ExtensionOptions.safeParse({ ...appOption, optionDelivery }).success, 'app').toBe(false);
		expect(ExtensionOptions.safeParse({ ...apiOption, optionDelivery }).success, 'endpoint').toBe(false);

		expect(ExtensionOptions.safeParse({ ...apiOption, type: 'hook', optionDelivery }).success, 'hook').toBe(false);

		expect(
			ExtensionOptions.safeParse({ ...bundleOption, runtime: 'confined-server', optionDelivery }).success,
			'bundle root'
		).toBe(false);

		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				runtime: 'confined-server',
				entries: [
					{
						type: 'operation',
						name: 'my-operation',
						source: { app: 'src/app.js', api: 'src/api.js' },
						optionDelivery,
					},
				],
			}).success,
			'bundle operation entry'
		).toBe(false);
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

describe('ExtensionOptions confined hook events', () => {
	const hookOption = { ...apiOption, type: 'hook', runtime: 'confined-server' as const };

	it('accepts a confined hook with exact event declarations', () => {
		const events = { filter: ['items.create', 'articles.items.update'], action: ['auth.login'] };
		expect(ExtensionOptions.safeParse({ ...hookOption, events }).success).toBe(true);
	});

	it('accepts a single-kind declaration', () => {
		expect(ExtensionOptions.safeParse({ ...hookOption, events: { action: ['server.start'] } }).success).toBe(true);
	});

	it('rejects events without the confined runtime', () => {
		const events = { action: ['auth.login'] };
		expect(ExtensionOptions.safeParse({ ...apiOption, type: 'hook', events }).success).toBe(false);
	});

	it('rejects events on anything but a hook rather than stripping them', () => {
		const events = { action: ['auth.login'] };

		expect(ExtensionOptions.safeParse({ ...apiOption, runtime: 'confined-server', events }).success, 'endpoint').toBe(
			false
		);

		expect(ExtensionOptions.safeParse({ ...appOption, events }).success, 'app').toBe(false);

		expect(
			ExtensionOptions.safeParse({ ...hybridOption, runtime: 'confined-server', events }).success,
			'operation'
		).toBe(false);

		expect(
			ExtensionOptions.safeParse({ ...bundleOption, runtime: 'confined-server', events }).success,
			'bundle root'
		).toBe(false);

		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				runtime: 'confined-server',
				entries: [{ type: 'endpoint', name: 'my-endpoint', source: 'src/endpoint.js', events }],
			}).success,
			'bundle endpoint entry'
		).toBe(false);

		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				runtime: 'confined-server',
				entries: [
					{ type: 'operation', name: 'my-operation', source: { app: 'src/app.js', api: 'src/api.js' }, events },
				],
			}).success,
			'bundle operation entry'
		).toBe(false);
	});

	it('accepts events on a confined bundle hook entry and requires the confined runtime', () => {
		const events = { action: ['items.create'] };

		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				runtime: 'confined-server',
				entries: [{ type: 'hook', name: 'my-hook', source: 'src/hook.js', events }],
			}).success,
			'confined bundle hook entry'
		).toBe(true);

		// Events on a bundle entry imply confinement, so a plain bundle is rejected.
		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				entries: [{ type: 'hook', name: 'my-hook', source: 'src/hook.js', events }],
			}).success,
			'plain bundle hook entry'
		).toBe(false);
	});

	it('requires events on a confined bundle hook entry but not an inherited one', () => {
		const hookEntry = { type: 'hook', name: 'my-hook', source: 'src/hook.js' };

		// An inherited bundle hook needs no manifest events, so a plain bundle accepts it.
		expect(ExtensionOptions.safeParse({ ...bundleOption, entries: [hookEntry] }).success, 'plain bundle hook').toBe(
			true
		);

		// A confined hook is inert without a subscription, so it must declare events.
		expect(
			ExtensionOptions.safeParse({ ...bundleOption, runtime: 'confined-server', entries: [hookEntry] }).success,
			'confined bundle hook without events'
		).toBe(false);

		// Declaring events implies the confined runtime, so a plain bundle hook with
		// events is still rejected.
		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				entries: [{ ...hookEntry, events: { action: ['items.create'] } }],
			}).success,
			'plain bundle hook with events'
		).toBe(false);
	});

	it('rejects an event name with a prototype or emitter-reserved segment in any position', () => {
		for (const name of [
			'__proto__',
			'constructor',
			'toString',
			'valueOf',
			'hasOwnProperty',
			'_listeners',
			'items.__proto__',
			'items.constructor.create',
			'a.toString',
			'_listeners.create',
			'a..b',
		]) {
			expect(ExtensionOptions.safeParse({ ...hookOption, events: { filter: [name] } }).success, name).toBe(false);
		}
	});

	it('accepts an event name that merely contains a prototype-like substring within a segment', () => {
		// `prototype` is not an Object.prototype member, and a reserved word inside a
		// longer segment is a distinct literal key, so neither aliases.
		for (const name of ['prototype', 'items.prototypes', 'constructor_id.create', 'my__proto__field']) {
			expect(ExtensionOptions.safeParse({ ...hookOption, events: { action: [name] } }).success, name).toBe(true);
		}
	});

	it('rejects an empty, wildcard, oversized, or duplicated declaration', () => {
		for (const events of [
			{},
			{ filter: [] },
			{ filter: ['*'] },
			{ filter: ['items.*'] },
			{ action: ['items.create', 'items.create'] },
			{ action: Array.from({ length: 17 }, (_, i) => `event.${i}`) },
			{ action: ['x'.repeat(129)] },
			{ schedule: ['*/5 * * * *'] },
		]) {
			expect(ExtensionOptions.safeParse({ ...hookOption, events }).success, JSON.stringify(events)).toBe(false);
		}
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
