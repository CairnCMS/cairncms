import { describe, expect, it } from 'vitest';
import { configApply, configSnapshot, createCairnCMS, rest } from '../src/index.js';
import type { ConfigDocumentV3 } from '../src/index.js';

const v3: ConfigDocumentV3 = {
	manifest: { version: 3, resources: ['roles'] },
	roles: [],
	permissions: [],
	folders: [],
	settings: [],
	'extension-settings': [],
	translations: [],
	schema: [],
};

function capturingClient() {
	const calls: { url: string; init: RequestInit }[] = [];

	const fetch = async (url: string, init: RequestInit) => {
		calls.push({ url, init });

		return new Response(JSON.stringify({ data: {} }), {
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		});
	};

	return { calls, client: createCairnCMS('http://localhost:8055', { globals: { fetch } }).with(rest()) };
}

describe('config command request construction', () => {
	it('sends configSnapshot without parameters by default, leaving the version and resources to the server', () => {
		const req = configSnapshot()();

		expect(req.method).toBe('GET');
		expect(req.path).toBe('/config/snapshot');
		expect(req.params).toEqual({});
		expect(req.envelope).toBeUndefined();
	});

	it('sends the requested manifest version and the resources as one comma-separated value', () => {
		const req = configSnapshot({ manifestVersion: 2, resources: ['roles', 'extension-settings'] })();

		expect(req.params).toEqual({ manifest_version: '2', resources: 'roles,extension-settings' });
	});

	it('sends an empty resources value for an empty list', async () => {
		expect(configSnapshot({ resources: [] })().params).toEqual({ resources: '' });

		const { calls, client } = capturingClient();
		await client.request(configSnapshot({ resources: [] }));

		expect(new URL(calls[0]!.url).search).toBe('?resources=');
	});

	it('sends configApply as a JSON body with no flags and keeps the whole response', () => {
		const req = configApply(v3)();

		expect(req.method).toBe('POST');
		expect(req.path).toBe('/config/apply');
		expect(req.params).toEqual({});
		expect(req.body).toBe(JSON.stringify(v3));
		expect(req.envelope).toBe(true);
	});

	it('sends dry_run for a dry run and returns only the plan', () => {
		const req = configApply(v3, { dryRun: true })();

		expect(req.params).toEqual({ dry_run: 'true' });
		expect(req.envelope).toBeUndefined();
	});

	it('sends destructive and force_schema only when they are true', () => {
		expect(configApply(v3, { destructive: true })().params).toEqual({ destructive: 'true' });
		expect(configApply(v3, { forceSchema: true })().params).toEqual({ force_schema: 'true' });

		expect(configApply(v3, { dryRun: false, destructive: false, forceSchema: false })().params).toEqual({});
	});

	it('puts every flag on the request URL with a JSON content type', async () => {
		const { calls, client } = capturingClient();
		await client.request(configApply(v3, { dryRun: true, destructive: true, forceSchema: true }));

		const url = new URL(calls[0]!.url);

		expect(url.pathname).toBe('/config/apply');
		expect(url.search).toBe('?dry_run=true&destructive=true&force_schema=true');
		expect(calls[0]!.init.method).toBe('POST');
		expect(calls[0]!.init.headers).toMatchObject({ 'Content-Type': 'application/json' });
		expect(calls[0]!.init.body).toBe(JSON.stringify(v3));
	});
});
