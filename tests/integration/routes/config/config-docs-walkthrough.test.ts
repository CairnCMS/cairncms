import { promises as fs } from 'node:fs';
import path from 'node:path';
import { expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import { setupRequest } from '../../fixtures/request';
import {
	assertDocsLabAbsent,
	assertDocsLabRestored,
	createDocsLab,
	docsManifest,
	docsSnapshot,
	DOCS_COLLECTION,
	DOCS_FOLDER,
	DOCS_ROLE,
	recordDocsEvidence,
	removeDocsLab,
} from '../../fixtures/config-docs';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

test('executes the first-apply guide in one disposable instance with an interactive confirmation', async ({ api }) => {
	await assertDocsLabAbsent(api);
	const directory = path.join(api.directory, 'config-demo');
	const commands: unknown[] = [];

	async function cli(args: string[], status: number, stdin?: string) {
		const result = await api.cli(args, { ...(stdin === undefined ? {} : { stdin }) });
		commands.push({ args, ...result });
		expect(result.status, result.stdout + result.stderr).toBe(status);
		return result;
	}

	try {
		await createDocsLab(api);
		await docsManifest(directory);
		await cli(['config', 'snapshot', directory, '--yes'], 0);
		const capture = await docsSnapshot(api);
		const files = await fs.readdir(directory, { recursive: true });
		expect(files).toContain('schema/articles.yaml');
		expect(files).toContain(`folders/${DOCS_FOLDER}.yaml`);
		expect(files).toContain(`roles/${DOCS_ROLE}.yaml`);
		expect((await cli(['config', 'apply', directory, '--dry-run'], 0)).stdout).toContain('No changes to apply.');

		await removeDocsLab(api);
		await assertDocsLabAbsent(api);
		const preview = await cli(['config', 'apply', directory, '--dry-run'], 1);
		expect(preview.stdout).toContain('Folder preparation');
		expect(preview.stdout).toContain(DOCS_COLLECTION);
		expect(preview.stdout).toContain(DOCS_ROLE);
		await assertDocsLabAbsent(api);

		await cli(['config', 'apply', directory], 0, 'y\n');
		await assertDocsLabRestored(api);
		expect(await docsSnapshot(api)).toEqual(capture);
		expect((await cli(['config', 'apply', directory, '--dry-run'], 0)).stdout).toContain('No changes to apply.');

		await recordDocsEvidence('local-walkthrough', {
			commands,
			files,
			captured: capture,
			restored: await docsSnapshot(api),
		});
	} finally {
		await removeDocsLab(api);
	}
});

test('reports JSON plans for matching and missing guide resources without writing', async ({ api }) => {
	await assertDocsLabAbsent(api);
	const directory = path.join(api.directory, 'config-json-preview');
	const snapshotArgs = ['config', 'snapshot', directory, '--yes'];
	const previewArgs = ['config', 'apply', directory, '--dry-run', '--format', 'json'];

	try {
		await createDocsLab(api);
		await docsManifest(directory);
		const snapshot = await api.cli(snapshotArgs);
		expect(snapshot.status, snapshot.stdout + snapshot.stderr).toBe(0);
		const capture = await docsSnapshot(api);
		const unchanged = await api.cli(previewArgs);
		expect(unchanged.status, unchanged.stdout + unchanged.stderr).toBe(0);
		const empty = JSON.parse(unchanged.stdout);

		expect(empty).toEqual({
			planVersion: 3,
			manifestVersion: 3,
			changes: [],
			summary: { create: 0, update: 0, delete: 0 },
			warnings: [],
			protections: [],
		});

		expect(await docsSnapshot(api)).toEqual(capture);
		await removeDocsLab(api);
		await assertDocsLabAbsent(api);
		const preview = await api.cli(previewArgs);
		expect(preview.status, preview.stdout + preview.stderr).toBe(1);
		const plan = JSON.parse(preview.stdout);
		expect(plan).toMatchObject({ planVersion: 3, preparation: [DOCS_FOLDER], summary: { delete: 0 } });
		await assertDocsLabAbsent(api);

		await recordDocsEvidence('local-json-previews', {
			commands: [
				{ args: snapshotArgs, ...snapshot },
				{ args: previewArgs, ...unchanged },
				{ args: previewArgs, ...preview },
			],
			plan,
			empty,
			captured: capture,
		});
	} finally {
		await removeDocsLab(api);
	}
});

test('captures and applies the guide document over HTTP with the documented success and no-op envelopes', async ({
	api,
}) => {
	await assertDocsLabAbsent(api);
	const exchanges: unknown[] = [];

	async function apply(body: object, dryRun = false) {
		const response = await setupRequest(api.url)
			.post('/config/apply')
			.query(dryRun ? { dry_run: true } : {})
			.auth(api.adminToken, { type: 'bearer' })
			.set('Content-Type', 'application/json')
			.send(body)
			.expect(200);

		exchanges.push({
			method: 'POST',
			path: dryRun ? '/config/apply?dry_run=true' : '/config/apply',
			body,
			status: response.status,
			response: response.body,
			runId: response.headers['x-config-run-id'],
		});

		return response.body;
	}

	try {
		await createDocsLab(api);
		const capture = await docsSnapshot(api);
		await removeDocsLab(api);
		await assertDocsLabAbsent(api);
		const preview = await apply(capture, true);
		expect(preview.data).toMatchObject({ planVersion: 3, preparation: [DOCS_FOLDER], summary: { delete: 0 } });
		await assertDocsLabAbsent(api);
		const applied = await apply(capture);

		expect(applied.meta).toMatchObject({
			result: 'applied',
			steps: { folders: 'committed', schema: 'committed', configuration: 'committed' },
		});

		expect(applied.data.roles.created).toEqual([DOCS_ROLE]);
		expect(applied.data.folders.created).toEqual([]);
		await assertDocsLabRestored(api);
		expect(await docsSnapshot(api)).toEqual(capture);
		const noop = await apply(capture);
		expect(noop.data).toBeNull();

		expect(noop.meta).toMatchObject({
			result: 'no_changes',
			steps: { folders: 'skipped', schema: 'skipped', configuration: 'skipped' },
		});

		const rolesOnly = await apply(await docsSnapshot(api, ['roles']));
		expect(rolesOnly.data.roles).toEqual({ created: [], updated: [], deleted: [] });

		expect(rolesOnly.meta).toMatchObject({
			result: 'no_changes',
			steps: { folders: 'not_run', schema: 'not_run', configuration: 'skipped' },
		});

		const schemaOnly = await docsSnapshot(api, ['schema']);

		await setupRequest(api.url)
			.delete(`/collections/${DOCS_COLLECTION}`)
			.auth(api.adminToken, { type: 'bearer' })
			.expect(204);

		const schemaResult = await apply(schemaOnly);
		expect(schemaResult.data).toBeNull();

		expect(schemaResult.meta).toMatchObject({
			result: 'applied',
			steps: { folders: 'skipped', schema: 'committed', configuration: 'skipped' },
		});

		await assertDocsLabRestored(api);
		await recordDocsEvidence('http-walkthrough', { captured: capture, exchanges });
	} finally {
		await removeDocsLab(api);
	}
});

test('applies the settings-only JSON example from the HTTP guide and reports the project document key', async ({
	api,
}) => {
	const guide = await fs.readFile(
		new URL('../../../../docs/manage/config-as-code/http-api.md', import.meta.url),
		'utf8'
	);

	const example = guide.match(/```json\n([\s\S]*?)\n```/);
	expect(example).not.toBeNull();
	const desired = JSON.parse(example![1]!);
	const original = await docsSnapshot(api, ['settings']);

	const post = (body: object) =>
		setupRequest(api.url)
			.post('/config/apply')
			.auth(api.adminToken, { type: 'bearer' })
			.set('Content-Type', 'application/json')
			.send(body)
			.expect(200);

	try {
		const applied = await post(desired);
		expect(applied.body.data.settings.updated).toEqual(['project']);
		expect((await docsSnapshot(api, ['settings'])).settings[0].project_name).toBe('Editorial');
		const noop = await post(desired);
		expect(noop.body.data.settings.updated).toEqual([]);
		expect(noop.body.meta.result).toBe('no_changes');
		await recordDocsEvidence('http-settings-example', { request: desired, applied: applied.body, noop: noop.body });
	} finally {
		await post(original);
	}
});
