import { describe, expect, it } from 'vitest';
import {
	ExtensionCapabilitiesSchema,
	ExtensionManifest,
	ExtensionOptions,
	ExtensionSecretPointerSchema,
	ExtensionSettingsSubjectSchema,
} from './extensions.js';

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

	it('rejects the removed settings, secrets, and jobs capabilities as unknown keys', () => {
		expect(ExtensionCapabilitiesSchema.safeParse({ settings: ['read'] }).success).toBe(false);
		expect(ExtensionCapabilitiesSchema.safeParse({ secrets: true }).success).toBe(false);
		expect(ExtensionCapabilitiesSchema.safeParse({ jobs: true }).success).toBe(false);
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

	it('rejects optionDelivery on app, endpoint, and hook types and on a bundle root rather than stripping it', () => {
		const optionDelivery = { apiKey: { delivery: 'reference' } };

		expect(ExtensionOptions.safeParse({ ...appOption, optionDelivery }).success, 'app').toBe(false);
		expect(ExtensionOptions.safeParse({ ...apiOption, optionDelivery }).success, 'endpoint').toBe(false);

		expect(ExtensionOptions.safeParse({ ...apiOption, type: 'hook', optionDelivery }).success, 'hook').toBe(false);

		expect(
			ExtensionOptions.safeParse({ ...bundleOption, runtime: 'confined-server', optionDelivery }).success,
			'bundle root'
		).toBe(false);
	});

	it('accepts optionDelivery on a confined bundle operation entry and requires the confined runtime', () => {
		const optionDelivery = { apiKey: { delivery: 'reference' } };

		const operationEntry = {
			type: 'operation',
			name: 'my-operation',
			source: { app: 'src/app.js', api: 'src/api.js' },
			optionDelivery,
		};

		// A confined bundle's operation entry may declare reference options, matching
		// top-level operation behavior.
		expect(
			ExtensionOptions.safeParse({ ...bundleOption, runtime: 'confined-server', entries: [operationEntry] }).success,
			'confined bundle operation entry'
		).toBe(true);

		// Without the confined runtime at the root, the declaration fails closed rather than
		// reaching the guest clear.
		expect(
			ExtensionOptions.safeParse({ ...bundleOption, entries: [operationEntry] }).success,
			'non-confined bundle operation entry'
		).toBe(false);

		// Only an operation entry may declare it. An endpoint, hook, or app entry may not,
		// even in a confined bundle, and the declaration is rejected rather than stripped.
		// Each sibling entry is otherwise valid, so the optionDelivery is the sole failure.
		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				runtime: 'confined-server',
				entries: [{ type: 'endpoint', name: 'ep', source: 'src/ep.js', optionDelivery }],
			}).success,
			'bundle endpoint entry'
		).toBe(false);

		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				runtime: 'confined-server',
				entries: [
					{ type: 'hook', name: 'hk', source: 'src/hk.js', events: { action: ['items.create'] }, optionDelivery },
				],
			}).success,
			'bundle hook entry'
		).toBe(false);

		expect(
			ExtensionOptions.safeParse({
				...bundleOption,
				runtime: 'confined-server',
				entries: [{ type: 'interface', name: 'ui', source: 'src/ui.js', optionDelivery }],
			}).success,
			'bundle app entry'
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

	it('accepts a confined bundle shell with no server entry as an editing state', () => {
		// The schema validates structure. A confined bundle with no server entry yet, the
		// state `create bundle --confined` writes before `add` fills it, is a valid shape.
		// The load gate, not the schema, refuses a loaded confined bundle that has no
		// server entry.
		const empty = ExtensionOptions.safeParse({ ...bundleOption, runtime: 'confined-server', entries: [] });

		const appOnly = ExtensionOptions.safeParse({
			...bundleOption,
			runtime: 'confined-server',
			entries: [{ type: 'interface', name: 'my-interface', source: 'src/interface.js' }],
		});

		expect(empty.success).toBe(true);
		expect(appOnly.success).toBe(true);
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

describe('ExtensionOptions settings declaration', () => {
	it('accepts a settings declaration on an app extension, which cannot declare capabilities', () => {
		const settings = { preview_url: { type: 'string', scope: 'collection' } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(true);
	});

	it('accepts a settings declaration on every extension type', () => {
		const settings = { preview_url: { type: 'string', scope: 'global' } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(true);
		expect(ExtensionOptions.safeParse({ ...apiOption, settings }).success).toBe(true);
		expect(ExtensionOptions.safeParse({ ...hybridOption, settings }).success).toBe(true);
		expect(ExtensionOptions.safeParse({ ...bundleOption, settings }).success).toBe(true);
	});

	it('accepts an extension that omits settings', () => {
		expect(ExtensionOptions.safeParse(appOption).success).toBe(true);
	});

	it('rejects an empty settings declaration so ownership is never ambiguous', () => {
		expect(ExtensionOptions.safeParse({ ...appOption, settings: {} }).success).toBe(false);
	});

	it('accepts a sensitive string setting', () => {
		const settings = { api_key: { type: 'string', scope: 'global', sensitive: true } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(true);
	});

	it('rejects a sensitive non-string setting', () => {
		const settings = { api_key: { type: 'number', scope: 'global', sensitive: true } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(false);
	});

	it('accepts an app-readable non-sensitive setting', () => {
		const settings = { preview_url: { type: 'string', scope: 'collection', appReadable: true } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(true);
	});

	it('rejects an app-readable sensitive setting', () => {
		const settings = { api_key: { type: 'string', scope: 'global', sensitive: true, appReadable: true } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(false);
	});

	it('rejects an unknown key inside a setting declaration', () => {
		const settings = { preview_url: { type: 'string', scope: 'global', surprise: true } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(false);
	});

	it('rejects an invalid type or scope', () => {
		expect(
			ExtensionOptions.safeParse({ ...appOption, settings: { x: { type: 'date', scope: 'global' } } }).success
		).toBe(false);

		expect(
			ExtensionOptions.safeParse({ ...appOption, settings: { x: { type: 'string', scope: 'tenant' } } }).success
		).toBe(false);
	});

	it('accepts a conventional snake_case key', () => {
		const settings = { preview_url: { type: 'string', scope: 'global' } };
		expect(ExtensionOptions.safeParse({ ...appOption, settings }).success).toBe(true);
	});

	it('rejects unsafe or reserved setting keys', () => {
		for (const key of [
			'__proto__',
			'constructor',
			'prototype',
			'Preview',
			'preview-url',
			'preview url',
			'preview.url',
			'1preview',
		]) {
			const settings = { [key]: { type: 'string', scope: 'global' } };
			expect(ExtensionOptions.safeParse({ ...appOption, settings }).success, key).toBe(false);
		}
	});
});

describe('ExtensionSettingsSubjectSchema', () => {
	it('accepts the package-name convention', () => {
		expect(ExtensionSettingsSubjectSchema.safeParse('cairncms-extension-foo').success).toBe(true);
		expect(ExtensionSettingsSubjectSchema.safeParse('@scope/cairncms-extension-foo').success).toBe(true);
		expect(ExtensionSettingsSubjectSchema.safeParse('@cairncms/extension-foo').success).toBe(true);
	});

	it('rejects a name outside the convention', () => {
		expect(ExtensionSettingsSubjectSchema.safeParse('my-extension').success).toBe(false);
		expect(ExtensionSettingsSubjectSchema.safeParse('').success).toBe(false);
	});

	it('rejects a subject longer than the storage bound', () => {
		expect(ExtensionSettingsSubjectSchema.safeParse(`cairncms-extension-${'x'.repeat(260)}`).success).toBe(false);
	});
});

describe('ExtensionSecretPointerSchema', () => {
	it('accepts a config pointer with a valid variable name', () => {
		expect(ExtensionSecretPointerSchema.safeParse({ source: 'config', name: 'MY_API_KEY' }).success).toBe(true);
		expect(ExtensionSecretPointerSchema.safeParse({ source: 'config', name: '_private' }).success).toBe(true);
	});

	it('rejects a non-config source, a malformed name, extra keys, and a raw value', () => {
		expect(ExtensionSecretPointerSchema.safeParse({ source: 'env', name: 'MY_API_KEY' }).success).toBe(false);
		expect(ExtensionSecretPointerSchema.safeParse({ source: 'config', name: '1bad' }).success).toBe(false);
		expect(ExtensionSecretPointerSchema.safeParse({ source: 'config', name: 'a b' }).success).toBe(false);
		expect(ExtensionSecretPointerSchema.safeParse({ source: 'config', name: '' }).success).toBe(false);
		expect(ExtensionSecretPointerSchema.safeParse({ source: 'config', name: 'OK', extra: true }).success).toBe(false);
		expect(ExtensionSecretPointerSchema.safeParse('raw-secret-value').success).toBe(false);
	});
});
