import { expect, vi } from 'vitest';
import { createApiTest, type Api } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

const test = createApiTest({
	env: { LOG_STYLE: 'raw', LOG_LEVEL: 'info' },
	hookFixtures: ['config-error-transport-probe'],
});

initializeFixtures();

const RUN_EVENT = 'config.run.finished';
const NOT_RUN = { folders: 'not_run', schema: 'not_run', configuration: 'not_run' };

// Matches the secret the config-error-transport-probe hook injects into the error.
const HOOK_SECRET = 'cairn-transport-probe-secret-7f3a';

// The marker the redaction layer leaves in place of a scrubbed value.
const REDACT_TEXT = '--redact--';

function runRecords(logs: string, runId: string): Array<Record<string, unknown>> {
	const records: Array<Record<string, unknown>> = [];

	for (const line of logs.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		try {
			const parsed = JSON.parse(trimmed);
			if (parsed?.event === RUN_EVENT && parsed?.runId === runId) records.push(parsed);
		} catch {
			// not a structured record line
		}
	}

	return records;
}

async function schemaTreeWithoutProvenance(api: Api): Promise<Record<string, unknown>> {
	const response = await request(api.url)
		.get('/config/snapshot')
		.query({ manifest_version: '3', resources: 'schema' })
		.set('Authorization', `Bearer ${api.adminToken}`);

	expect(response.statusCode).toBe(200);

	const desired = response.body.data as { manifest: Record<string, unknown> };
	delete desired.manifest['schema'];

	return desired as Record<string, unknown>;
}

test('carries the step outcome through the error middleware and redacts a hooked secret', async ({ api }) => {
	const desired = await schemaTreeWithoutProvenance(api);

	const response = await request(api.url)
		.post('/config/apply')
		.set('Authorization', `Bearer ${api.adminToken}`)
		.set('Content-Type', 'application/json')
		.send(desired);

	expect(response.statusCode).toBe(400);

	const error = response.body.errors[0];
	expect(error.extensions.code).toBe('CONFIG_SCHEMA_SOURCE');
	expect(error.extensions.probe_marker).toBe('request-error-hook');
	expect(error.extensions.steps).toEqual(NOT_RUN);
	expect(error.extensions).not.toHaveProperty('failure');

	expect(error.extensions.access_token).toBe(REDACT_TEXT);
	expect(error.message).toContain(`access_token=${REDACT_TEXT}`);
	expect(JSON.stringify(response.body)).not.toContain(HOOK_SECRET);

	const runId = response.headers['x-config-run-id'];
	expect(typeof runId).toBe('string');

	const records = await vi.waitFor(
		async () => {
			const found = runRecords(await api.readLogs(), runId);
			if (found.length === 0) throw new Error('config run record not written yet');
			return found;
		},
		{ timeout: 10_000, interval: 100 }
	);

	expect(records).toHaveLength(1);
	expect(records[0]!['result']).toBe('refused');
	expect(records[0]!['steps']).toEqual(NOT_RUN);
	expect(records[0]).not.toHaveProperty('failure');
});
