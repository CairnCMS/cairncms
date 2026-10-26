import { describe, expect, it } from 'vitest';
import { createCairnCMS, customEndpoint, rest } from '../src/index.js';

const appliedBody = {
	data: null,
	meta: {
		plan: {
			planVersion: 3,
			manifestVersion: 3,
			changes: [
				{
					kind: 'collections',
					operation: 'create',
					identity: { collection: 'articles' },
					values: { collection: 'articles' },
				},
			],
			summary: { create: 1, update: 0, delete: 0 },
			warnings: [],
			protections: [],
		},
		result: 'applied',
		steps: { folders: 'skipped', schema: 'committed', configuration: 'skipped' },
	},
};

const partialFailureBody = {
	errors: [
		{
			message:
				'The schema apply failed and may have left changes in place. Inspect the reported persisted state before retrying.',
			extensions: {
				code: 'SCHEMA_APPLY_FAILED',
				persisted: 'unknown',
				steps: { folders: 'committed', schema: 'unknown', configuration: 'not_run' },
				failure: { step: 'schema', detail: { persisted: 'unknown' } },
			},
		},
	],
};

type RequestRejection = {
	errors: Array<{ message: string; extensions: Record<string, unknown> }>;
	response: Response;
};

const enveloped = customEndpoint({ path: '/config/apply', method: 'POST', envelope: true });
const unwrapped = customEndpoint({ path: '/config/apply', method: 'POST' });

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function clientResolving(result: unknown) {
	return createCairnCMS('http://localhost:8055', { globals: { fetch: async () => result } }).with(rest());
}

describe('REST response envelope', () => {
	it('returns the whole JSON body when the command opts in', async () => {
		await expect(clientResolving(jsonResponse(appliedBody)).request(enveloped)).resolves.toEqual(appliedBody);
	});

	it('returns only data when the command does not opt in', async () => {
		await expect(clientResolving(jsonResponse(appliedBody)).request(unwrapped)).resolves.toBeNull();
	});

	it('returns the whole body from a fetcher that resolves parsed JSON when the command opts in', async () => {
		await expect(clientResolving(structuredClone(appliedBody)).request(enveloped)).resolves.toEqual(appliedBody);
	});

	it('returns only data from a fetcher that resolves parsed JSON when the command does not opt in', async () => {
		await expect(clientResolving(structuredClone(appliedBody)).request(unwrapped)).resolves.toBeNull();
	});

	it.each([
		['opts in', enveloped],
		['does not opt in', unwrapped],
	])('rejects a partial failure with its steps, failure and response when the command %s', async (_, command) => {
		const response = jsonResponse(partialFailureBody, 500);

		const rejection = await clientResolving(response)
			.request(command)
			.then(
				() => {
					throw new Error('Expected the request to reject');
				},
				(error: RequestRejection) => error
			);

		expect(rejection.errors).toEqual(partialFailureBody.errors);
		expect(rejection.errors[0]!.extensions['code']).toBe('SCHEMA_APPLY_FAILED');

		expect(rejection.errors[0]!.extensions['steps']).toEqual({
			folders: 'committed',
			schema: 'unknown',
			configuration: 'not_run',
		});

		expect(rejection.errors[0]!.extensions['failure']).toEqual({ step: 'schema', detail: { persisted: 'unknown' } });
		expect(rejection.response).toBe(response);
	});
});
