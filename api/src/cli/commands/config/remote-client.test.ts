import { describe, expect, it } from 'vitest';
import type { CairnConfig } from '../../../types/config.js';
import { deleteVerb } from '../../presentation.js';
import { parseOperatorRemoteTarget } from './operator-remote-target.js';
import {
	applyRemote,
	assertServerSupportsRemoteConfig,
	fetchRemoteSnapshot,
	fetchServerVersion,
	RemoteClientError,
	type RemoteSession,
} from './remote-client.js';

const TOKEN = 'secret-token-123';
const BEL = String.fromCharCode(7);

const BODY: CairnConfig = { manifest: { version: 1, resources: ['roles', 'permissions'] }, roles: [], permissions: [] };

const ROLES_ONLY_BODY: CairnConfig = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] };

const ROLE_CREATE = {
	kind: 'roles',
	operation: 'create',
	identity: { key: 'editor' },
	values: {
		name: 'Editor',
		icon: 'badge',
		description: null,
		admin_access: false,
		app_access: true,
		enforce_tfa: false,
		ip_access: null,
	},
};

const PERMISSION_CREATE = {
	kind: 'permissions',
	operation: 'create',
	identity: { role: 'editor', collection: 'articles', action: 'read' },
	values: { permissions: null, validation: null, presets: null, fields: null },
};

function session(responder: (config: any) => { status: number; data: unknown }): {
	remote: RemoteSession;
	requests: any[];
} {
	const requests: any[] = [];

	const remote: RemoteSession = {
		transport: {
			request: async (config: any) => {
				requests.push(config);
				return responder(config);
			},
		} as any,
		target: parseOperatorRemoteTarget('https://cms.example/'),
		token: TOKEN,
	};

	return { remote, requests };
}

async function caught(fn: () => Promise<unknown>): Promise<RemoteClientError> {
	try {
		await fn();
	} catch (err) {
		return err as RemoteClientError;
	}

	throw new Error('expected a rejection');
}

const OK_PLAN = {
	planVersion: 2,
	manifestVersion: 1,
	changes: [],
	summary: { create: 0, update: 0, delete: 0 },
	protections: [],
	warnings: [],
};

const DEEP_PLAN = {
	planVersion: 2,
	manifestVersion: 1,
	summary: { create: 0, update: 1, delete: 1 },
	changes: [
		{
			kind: 'roles',
			operation: 'update',
			identity: { key: 'editor' },
			fields: { name: { before: 'Old', after: 'Editor' } },
		},
		{
			kind: 'roles',
			operation: 'delete',
			identity: { key: 'legacy' },
			impact: [
				{ kind: 'permissions', identity: { role: 'legacy', collection: 'articles', action: 'read' } },
				{ kind: 'presets', count: 2, bookmarks: ['saved'] },
				{ kind: 'users', suspended: ['u1'] },
				{ kind: 'sessions', active: 1 },
			],
		},
	],
	protections: [
		{
			code: 'ADMIN_CONTINUITY_REQUIRED',
			message: 'protected',
			contributors: [{ kind: 'roles', operation: 'delete', identity: { key: 'admin' } }],
		},
	],
	warnings: [
		{
			code: 'COLLECTION_MISSING',
			kind: 'permissions',
			identity: { role: 'editor', collection: 'ghost', action: 'read' },
			message: 'missing',
		},
	],
};

const OK_RESULT = {
	roles: { created: [], updated: [], deleted: [] },
	permissions: { created: 0, updated: 0, deleted: 0 },
};

function dryRun(plan: unknown): Promise<RemoteClientError> {
	const { remote } = session(() => ({ status: 200, data: { data: plan } }));
	return caught(() => applyRemote(remote, BODY, { dryRun: true, destructive: false }));
}

describe('fetchServerVersion', () => {
	it('sends a Bearer token to /server/info and returns the version', async () => {
		const { remote, requests } = session(() => ({ status: 200, data: { data: { cairncms: { version: '1.6.0' } } } }));

		expect(await fetchServerVersion(remote)).toBe('1.6.0');
		expect(requests[0].url).toBe('https://cms.example/server/info');
		expect(requests[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it('fails at exit 3 when the version is absent', async () => {
		const { remote } = session(() => ({ status: 200, data: { data: {} } }));
		expect((await caught(() => fetchServerVersion(remote))).exitCode).toBe(3);
	});
});

describe('assertServerSupportsRemoteConfig', () => {
	it('accepts the floor and newer releases', () => {
		expect(() => assertServerSupportsRemoteConfig('1.6.0', TOKEN)).not.toThrow();
		expect(() => assertServerSupportsRemoteConfig('1.7.3', TOKEN)).not.toThrow();
		expect(() => assertServerSupportsRemoteConfig('2.0.0', TOKEN)).not.toThrow();
	});

	it('refuses a below-floor release at exit 2', () => {
		expect(assertThrow(() => assertServerSupportsRemoteConfig('1.5.0', TOKEN)).exitCode).toBe(2);
	});

	it('refuses a prerelease of the floor at exit 2', () => {
		expect(assertThrow(() => assertServerSupportsRemoteConfig('1.6.0-rc.1', TOKEN)).exitCode).toBe(2);
	});

	it('refuses an unrecognized version at exit 3', () => {
		expect(assertThrow(() => assertServerSupportsRemoteConfig('not-a-version', TOKEN)).exitCode).toBe(3);
	});

	it('refuses a version with leading-zero components at exit 3', () => {
		expect(assertThrow(() => assertServerSupportsRemoteConfig('01.6.0', TOKEN)).exitCode).toBe(3);
	});

	it('refuses a malformed prerelease at exit 3', () => {
		expect(assertThrow(() => assertServerSupportsRemoteConfig('1.7.0-!', TOKEN)).exitCode).toBe(3);
	});

	it('refuses an oversized release component at exit 3', () => {
		expect(assertThrow(() => assertServerSupportsRemoteConfig('1.99999999999999999.0', TOKEN)).exitCode).toBe(3);
	});

	it('redacts the token and strips control bytes from the reported version', () => {
		const error = assertThrow(() => assertServerSupportsRemoteConfig(`${TOKEN}${BEL}`, TOKEN));

		expect(error.message).not.toContain(TOKEN);
		expect(error.message).not.toContain(BEL);
	});
});

describe('applyRemote', () => {
	it('returns the plan for a dry run', async () => {
		const { remote, requests } = session(() => ({ status: 200, data: { data: OK_PLAN } }));

		const outcome = await applyRemote(remote, BODY, { dryRun: true, destructive: false });

		expect(outcome).toEqual({ plan: OK_PLAN });
		expect(requests[0].params).toEqual({ dry_run: 'true' });
	});

	it('accepts a fully populated plan with protections and role-deletion impact', async () => {
		const { remote } = session(() => ({ status: 200, data: { data: DEEP_PLAN } }));

		const outcome = await applyRemote(remote, BODY, { dryRun: true, destructive: false });

		expect(outcome.plan).toEqual(DEEP_PLAN);
	});

	it('returns plan and result for a mutating apply', async () => {
		const { remote } = session(() => ({ status: 200, data: { data: OK_RESULT, meta: { plan: OK_PLAN } } }));

		const outcome = await applyRemote(remote, BODY, { dryRun: false, destructive: true });

		expect(outcome).toEqual({ plan: OK_PLAN, result: OK_RESULT });
	});

	it('refuses a plan for a different manifest version than the one submitted', async () => {
		const { remote } = session(() => ({ status: 200, data: { data: { ...OK_PLAN, manifestVersion: 2 } } }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: true, destructive: false }));

		expect(error.exitCode).toBe(3);
		expect(error.message).toBe('The server returned a plan for a different manifest than the one submitted.');
	});

	it('refuses a plan carrying a change for a kind the submitted manifest does not manage', async () => {
		const plan = { ...OK_PLAN, summary: { create: 1, update: 0, delete: 0 }, changes: [PERMISSION_CREATE] };
		const result = { ...OK_RESULT, permissions: { created: 1, updated: 0, deleted: 0 } };

		const dry = session(() => ({ status: 200, data: { data: plan } }));
		const dryError = await caught(() => applyRemote(dry.remote, ROLES_ONLY_BODY, { dryRun: true, destructive: false }));

		expect(dryError.exitCode).toBe(3);
		expect(dryError.message).toBe('The server returned a plan for a different manifest than the one submitted.');

		const mutating = session(() => ({ status: 200, data: { data: result, meta: { plan } } }));

		const mutatingError = await caught(() =>
			applyRemote(mutating.remote, ROLES_ONLY_BODY, { dryRun: false, destructive: false })
		);

		expect(mutatingError.exitCode).toBe(3);
		expect(mutatingError.message).toContain('a different manifest than the one submitted');
		expect(mutatingError.message).toContain('re-snapshot to verify the current state');

		const accepted = session(() => ({ status: 200, data: { data: result, meta: { plan } } }));

		await expect(applyRemote(accepted.remote, BODY, { dryRun: false, destructive: false })).resolves.toEqual({
			plan,
			result,
		});
	});

	it('refuses a plan whose summary does not match its changes', async () => {
		const plan = { ...OK_PLAN, summary: { create: 1, update: 0, delete: 0 } };

		const dry = session(() => ({ status: 200, data: { data: plan } }));
		const dryError = await caught(() => applyRemote(dry.remote, BODY, { dryRun: true, destructive: false }));

		expect(dryError.exitCode).toBe(3);
		expect(dryError.message).toBe('The server returned a plan whose summary does not match its changes.');

		const mutating = session(() => ({ status: 200, data: { data: OK_RESULT, meta: { plan } } }));
		const mutatingError = await caught(() => applyRemote(mutating.remote, BODY, { dryRun: false, destructive: false }));

		expect(mutatingError.exitCode).toBe(3);
		expect(mutatingError.message).toContain('summary does not match its changes');
		expect(mutatingError.message).toContain('re-snapshot to verify the current state');
	});

	it('refuses a mutating success whose plan still lists protected changes, with the unknown-outcome note', async () => {
		const plan = { ...OK_PLAN, protections: DEEP_PLAN.protections };
		const { remote } = session(() => ({ status: 200, data: { data: OK_RESULT, meta: { plan } } }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.exitCode).toBe(3);

		expect(error.message).toBe(
			'The server reported a successful apply but its plan still lists protected changes. The server may have already applied the change; re-snapshot to verify the current state.'
		);
	});

	it('refuses a mutating result whose counts do not match the plan, and accepts one that does', async () => {
		const plan = {
			...OK_PLAN,
			summary: { create: 2, update: 0, delete: 0 },
			changes: [ROLE_CREATE, PERMISSION_CREATE],
		};

		const short = session(() => ({ status: 200, data: { data: OK_RESULT, meta: { plan } } }));
		const shortError = await caught(() => applyRemote(short.remote, BODY, { dryRun: false, destructive: false }));

		expect(shortError.exitCode).toBe(3);

		expect(shortError.message).toBe(
			'The server reported a result that does not match its plan. The server may have already applied the change; re-snapshot to verify the current state.'
		);

		const wrongKind = {
			roles: { created: ['a', 'b'], updated: [], deleted: [] },
			permissions: { created: 0, updated: 0, deleted: 0 },
		};

		const swapped = session(() => ({ status: 200, data: { data: wrongKind, meta: { plan } } }));
		const swappedError = await caught(() => applyRemote(swapped.remote, BODY, { dryRun: false, destructive: false }));

		expect(swappedError.message).toContain('a result that does not match its plan');

		const result = {
			roles: { created: ['4a3b'], updated: [], deleted: [] },
			permissions: { created: 1, updated: 0, deleted: 0 },
		};

		const matching = session(() => ({ status: 200, data: { data: result, meta: { plan } } }));

		await expect(applyRemote(matching.remote, BODY, { dryRun: false, destructive: false })).resolves.toEqual({
			plan,
			result,
		});
	});

	it('fails at exit 3 when a mutating apply omits meta.plan', async () => {
		const { remote } = session(() => ({ status: 200, data: { data: OK_RESULT } }));
		expect((await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }))).exitCode).toBe(3);
	});

	it('maps a 4xx to exit 2 with the server message and without the token', async () => {
		const { remote } = session(() => ({
			status: 422,
			data: { errors: [{ message: 'invalid config', extensions: { code: 'CONFIG_INVALID' } }] },
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.exitCode).toBe(2);
		expect(error.message).toContain('invalid config');
		expect(error.message).not.toContain(TOKEN);
	});

	it('does not warn of an unknown outcome on a 4xx, which is refused before commit', async () => {
		const { remote } = session(() => ({ status: 422, data: { errors: [{ message: 'invalid config' }] } }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.message).not.toContain('re-snapshot');
	});

	describe('run id header', () => {
		const RUN_ID = '3f6c1b0e-9b2c-4a1d-8f2e-0a7d5c4b3e21';

		function sessionWithHeader(header: unknown, status = 200, data: unknown = { data: OK_PLAN }) {
			return session(() => ({ status, data, headers: { 'x-config-run-id': header } } as never));
		}

		it('returns a UUID run id from the response header', async () => {
			const { remote } = sessionWithHeader(RUN_ID);

			const outcome = await applyRemote(remote, BODY, { dryRun: true, destructive: false });

			expect(outcome).toEqual({ plan: OK_PLAN, runId: RUN_ID });
		});

		it('returns the run id on a mutating apply', async () => {
			const { remote } = sessionWithHeader(RUN_ID, 200, { data: OK_RESULT, meta: { plan: OK_PLAN } });

			const outcome = await applyRemote(remote, BODY, { dryRun: false, destructive: false });

			expect(outcome).toEqual({ plan: OK_PLAN, result: OK_RESULT, runId: RUN_ID });
		});

		it('omits the run id when the header is absent', async () => {
			const { remote } = session(() => ({ status: 200, data: { data: OK_PLAN } }));

			const outcome = await applyRemote(remote, BODY, { dryRun: true, destructive: false });

			expect(outcome).not.toHaveProperty('runId');
		});

		it.each([
			['a non-UUID', 'run-123'],
			['control characters', `${RUN_ID}${BEL}`],
			['the token', TOKEN],
			['an array', [RUN_ID]],
			['an empty string', ''],
		])('ignores a header carrying %s', async (_label, header) => {
			const { remote } = sessionWithHeader(header);

			const outcome = await applyRemote(remote, BODY, { dryRun: true, destructive: false });

			expect(outcome).not.toHaveProperty('runId');
		});

		it('carries the run id on a server refusal', async () => {
			const { remote } = sessionWithHeader(RUN_ID, 400, { errors: [{ message: 'refused' }] });

			const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

			expect(error.exitCode).toBe(2);
			expect(error.runId).toBe(RUN_ID);
		});

		it('carries the run id on a malformed mutating response with the unknown-outcome note', async () => {
			const { remote } = sessionWithHeader(RUN_ID, 200, { data: OK_RESULT });

			const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

			expect(error.exitCode).toBe(3);
			expect(error.runId).toBe(RUN_ID);
			expect(error.message).toContain('re-snapshot');
		});

		it('carries the run id on a malformed dry-run plan without the unknown-outcome note', async () => {
			const { remote } = sessionWithHeader(RUN_ID, 200, { data: { planVersion: 2 } });

			const error = await caught(() => applyRemote(remote, BODY, { dryRun: true, destructive: false }));

			expect(error.exitCode).toBe(3);
			expect(error.runId).toBe(RUN_ID);
			expect(error.message).not.toContain('re-snapshot');
		});
	});

	it('maps a 5xx to exit 3', async () => {
		const { remote } = session(() => ({ status: 503, data: { errors: [{ message: 'unavailable' }] } }));
		expect((await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }))).exitCode).toBe(3);
	});

	it('warns that a mutating 5xx may have committed', async () => {
		const { remote } = session(() => ({ status: 500, data: { errors: [{ message: 'boom' }] } }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.message).toContain('re-snapshot');
	});

	it('does not warn of an unknown outcome on a dry-run 5xx', async () => {
		const { remote } = session(() => ({ status: 500, data: { errors: [{ message: 'boom' }] } }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: true, destructive: false }));

		expect(error.message).not.toContain('re-snapshot');
	});

	it('warns that a malformed mutating response may have committed', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: { data: { roles: {}, permissions: {} }, meta: { plan: OK_PLAN } },
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('re-snapshot');
	});

	it('rejects a 3xx redirect response at exit 3 without an unknown-outcome note on a dry run', async () => {
		const { remote } = session(() => ({ status: 302, data: OK_PLAN }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: true, destructive: false }));

		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('redirect');
		expect(error.message).not.toContain('re-snapshot');
	});

	it('warns that a mutating 3xx redirect may have committed', async () => {
		const { remote } = session(() => ({ status: 302, data: OK_RESULT }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('re-snapshot');
	});

	it('maps a transport failure to exit 3 without leaking the token', async () => {
		const remote: RemoteSession = {
			transport: {
				request: async () => {
					throw Object.assign(new Error(`connect ${TOKEN}${BEL} ECONNREFUSED`), { code: '' });
				},
			} as any,
			target: parseOperatorRemoteTarget('https://cms.example/'),
			token: TOKEN,
		};

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: true, destructive: false }));

		expect(error.exitCode).toBe(3);
		expect(error.message).not.toContain(TOKEN);
		expect(error.message).not.toContain(BEL);
	});

	it('rejects a non-JSON response at exit 3', async () => {
		const { remote } = session(() => ({ status: 200, data: '<html>proxy error</html>' }));
		expect((await caught(() => applyRemote(remote, BODY, { dryRun: true, destructive: false }))).exitCode).toBe(3);
	});

	it('rejects a dry-run plan missing manifestVersion at exit 3', async () => {
		const { manifestVersion: _drop, ...noVersion } = OK_PLAN;
		expect((await dryRun(noVersion)).exitCode).toBe(3);
	});

	it('rejects a protection without a contributors array at exit 3', async () => {
		const plan = { ...OK_PLAN, protections: [{ code: 'ADMIN_CONTINUITY_REQUIRED', message: 'protected' }] };
		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a contributor without an identity key at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			protections: [
				{ code: 'ADMIN_CONTINUITY_REQUIRED', message: 'protected', contributors: [{ operation: 'delete' }] },
			],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a create change without values at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			summary: { create: 1, update: 0, delete: 0 },
			changes: [{ kind: 'roles', operation: 'create', identity: { key: 'editor' } }],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a protection without a code at exit 3', async () => {
		const plan = { ...OK_PLAN, protections: [{ message: 'protected', contributors: [] }] };
		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a warning without a code at exit 3', async () => {
		const plan = { ...OK_PLAN, warnings: [{ message: 'missing' }] };
		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a contributor without a kind at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			protections: [
				{
					code: 'ADMIN_CONTINUITY_REQUIRED',
					message: 'protected',
					contributors: [{ operation: 'delete', identity: { key: 'admin' } }],
				},
			],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a contributor with a create operation at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			protections: [
				{
					code: 'ADMIN_CONTINUITY_REQUIRED',
					message: 'protected',
					contributors: [{ kind: 'roles', operation: 'create', identity: { key: 'admin' } }],
				},
			],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a negative or non-integral result count at exit 3', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: {
				data: {
					roles: { created: [], updated: [], deleted: [] },
					permissions: { created: -1, updated: 0, deleted: 0 },
				},
				meta: { plan: OK_PLAN },
			},
		}));

		expect((await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }))).exitCode).toBe(3);
	});

	it('rejects a create change whose values have the wrong shape at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			summary: { create: 1, update: 0, delete: 0 },
			changes: [
				{
					kind: 'roles',
					operation: 'create',
					identity: { key: 'editor' },
					values: { name: 'Editor', icon: 'lock', description: null, admin_access: 'yes', app_access: false },
				},
			],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a known COLLECTION_MISSING warning without its kind and identity at exit 3', async () => {
		const plan = { ...OK_PLAN, warnings: [{ code: 'COLLECTION_MISSING', message: 'missing' }] };
		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a plan permission identity with an unsupported action at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			summary: { create: 0, update: 0, delete: 1 },
			changes: [
				{
					kind: 'permissions',
					operation: 'delete',
					identity: { role: 'editor', collection: 'articles', action: 'frobnicate' },
					impact: [],
				},
			],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a permission deletion carrying a non-empty impact at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			summary: { create: 0, update: 0, delete: 1 },
			changes: [
				{
					kind: 'permissions',
					operation: 'delete',
					identity: { role: 'editor', collection: 'articles', action: 'read' },
					impact: [{ kind: 'sessions', active: 1 }],
				},
			],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a role-deletion impact entry with a malformed permission at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			summary: { create: 0, update: 0, delete: 1 },
			changes: [
				{
					kind: 'roles',
					operation: 'delete',
					identity: { key: 'legacy' },
					impact: [{ kind: 'permissions', identity: { collection: 'articles' } }],
				},
			],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects an update field without an after value at exit 3', async () => {
		const plan = {
			...OK_PLAN,
			summary: { create: 0, update: 1, delete: 0 },
			changes: [{ kind: 'roles', operation: 'update', identity: { key: 'editor' }, fields: { name: {} } }],
		};

		expect((await dryRun(plan)).exitCode).toBe(3);
	});

	it('rejects a mutating result missing role arrays at exit 3', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: { data: { roles: {}, permissions: {} }, meta: { plan: OK_PLAN } },
		}));

		expect((await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }))).exitCode).toBe(3);
	});

	it('preserves an unknown protection or warning code in a plan', async () => {
		const plan = {
			...OK_PLAN,
			protections: [{ code: 'FUTURE_PROTECTION', message: 'future', contributors: [] }],
			warnings: [{ code: 'FUTURE_WARNING', message: 'future' }],
		};

		const { remote } = session(() => ({ status: 200, data: { data: plan } }));
		expect((await applyRemote(remote, BODY, { dryRun: true, destructive: false })).plan).toEqual(plan);
	});

	it('redacts the token and strips control bytes from a server error', async () => {
		const { remote } = session(() => ({ status: 400, data: { errors: [{ message: `bad ${TOKEN}${BEL} config` }] } }));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.message).not.toContain(TOKEN);
		expect(error.message).not.toContain(BEL);
	});

	it('prints every error entry the server returned', async () => {
		const { remote } = session(() => ({
			status: 400,
			data: {
				errors: [
					{ message: 'first failure', extensions: { code: 'CONFIG_INVALID' } },
					{ message: `second ${BEL}failure`, extensions: { code: 'CONFIG_IDENTITY_CONFLICT' } },
				],
			},
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.exitCode).toBe(2);
		expect(error.message).toBe('The server rejected the request (400): first failure\nsecond ?failure');
	});

	it('renders the deletions a destructive refusal names', async () => {
		const { remote } = session(() => ({
			status: 400,
			data: {
				errors: [
					{
						message: 'The configuration plan contains deletions. Re-run with the destructive option to authorize them.',
						extensions: {
							code: 'DESTRUCTIVE_CHANGES_REQUIRED',
							deletions: [
								{ kind: 'roles', identity: { key: 'legacy' } },
								{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
							],
						},
					},
				],
			},
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.exitCode).toBe(2);

		expect(error.message).toBe(
			`The server rejected the request (400): The configuration plan contains deletions. Re-run with the destructive option to authorize them.\n    - ${deleteVerb()} legacy\n    - ${deleteVerb()} editor / articles / read`
		);
	});

	it('renders the contributors a protected refusal names with the local verbs', async () => {
		const { remote } = session(() => ({
			status: 400,
			data: {
				errors: [
					{
						message: 'Would remove the last administrator',
						extensions: {
							code: 'CONFIG_PROTECTED_RECORD',
							protection: { code: 'ADMIN_CONTINUITY_REQUIRED' },
							contributors: [
								{ kind: 'roles', operation: 'delete', identity: { key: 'admin' } },
								{ kind: 'roles', operation: 'update', identity: { key: `ops${BEL}` } },
							],
						},
					},
				],
			},
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.message).toBe(
			'The server rejected the request (400): Would remove the last administrator\n    - Deletes admin\n    - Removes administrator access from ops?'
		);
	});

	it('falls back to the message alone when an extension shape is unrecognized', async () => {
		const { remote } = session(() => ({
			status: 400,
			data: {
				errors: [
					{
						message: 'refused',
						extensions: {
							code: 'DESTRUCTIVE_CHANGES_REQUIRED',
							deletions: [{ kind: 'flows', identity: { key: 'x' } }],
						},
					},
					{ extensions: { code: 'NO_MESSAGE' } },
				],
			},
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.message).toBe('The server rejected the request (400): refused');
	});

	it('renders extension detail only under the error code that defines it', async () => {
		const { remote } = session(() => ({
			status: 400,
			data: {
				errors: [
					{
						message: 'invalid document',
						extensions: {
							code: 'CONFIG_INVALID',
							deletions: [{ kind: 'roles', identity: { key: 'legacy' } }],
							contributors: [{ kind: 'roles', operation: 'delete', identity: { key: 'admin' } }],
						},
					},
					{
						message: 'wrong code for contributors',
						extensions: {
							code: 'DESTRUCTIVE_CHANGES_REQUIRED',
							contributors: [{ kind: 'roles', operation: 'delete', identity: { key: 'admin' } }],
						},
					},
				],
			},
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.message).toBe('The server rejected the request (400): invalid document\nwrong code for contributors');
	});

	it('redacts the token from deletion and contributor identities', async () => {
		const { remote } = session(() => ({
			status: 400,
			data: {
				errors: [
					{
						message: 'deletions',
						extensions: {
							code: 'DESTRUCTIVE_CHANGES_REQUIRED',
							deletions: [
								{ kind: 'roles', identity: { key: `role_${TOKEN}` } },
								{ kind: 'permissions', identity: { role: 'editor', collection: TOKEN, action: 'read' } },
							],
						},
					},
					{
						message: 'protected',
						extensions: {
							code: 'CONFIG_PROTECTED_RECORD',
							contributors: [{ kind: 'roles', operation: 'delete', identity: { key: TOKEN } }],
						},
					},
				],
			},
		}));

		const error = await caught(() => applyRemote(remote, BODY, { dryRun: false, destructive: false }));

		expect(error.message).not.toContain(TOKEN);
		expect(error.message).toContain(`${deleteVerb()} role_[redacted]`);
		expect(error.message).toContain(`${deleteVerb()} editor / [redacted] / read`);
		expect(error.message).toContain('Deletes [redacted]');
	});

	it('redacts a token that carries a control byte from identities the renderer neutralizes', async () => {
		const token = `sec${BEL}ret`;

		const { remote } = session(() => ({
			status: 400,
			data: {
				errors: [
					{
						message: 'protected',
						extensions: {
							code: 'CONFIG_PROTECTED_RECORD',
							contributors: [{ kind: 'roles', operation: 'delete', identity: { key: `admin_${token}` } }],
						},
					},
					{
						message: 'deletions',
						extensions: {
							code: 'DESTRUCTIVE_CHANGES_REQUIRED',
							deletions: [{ kind: 'permissions', identity: { role: 'editor', collection: token, action: 'read' } }],
						},
					},
				],
			},
		}));

		const error = await caught(() => applyRemote({ ...remote, token }, BODY, { dryRun: false, destructive: false }));

		expect(error.message).not.toContain('sec?ret');
		expect(error.message).not.toContain(BEL);
		expect(error.message).toContain('Deletes admin_[redacted]');
		expect(error.message).toContain(`${deleteVerb()} editor / [redacted] / read`);
	});
});

describe('fetchRemoteSnapshot', () => {
	const scope = { manifestVersion: 1, resources: ['roles', 'permissions'] as const };

	const VALID_SNAPSHOT = {
		manifest: { version: 1, resources: ['roles', 'permissions'] },
		roles: [{ key: 'editor', name: 'Editor', admin_access: false, app_access: true }],
		permissions: [
			{
				role: 'editor',
				permissions: [
					{ collection: 'articles', action: 'read', permissions: {}, validation: null, presets: null, fields: ['*'] },
				],
			},
		],
	};

	it('returns a fully validated snapshot as a fresh envelope, not the response object', async () => {
		const { remote } = session(() => ({ status: 200, data: { data: VALID_SNAPSHOT } }));

		const snapshot = await fetchRemoteSnapshot(remote, scope);

		expect(snapshot).toEqual(VALID_SNAPSHOT);
		expect(snapshot).not.toBe(VALID_SNAPSHOT);
	});

	it('accepts a permissions-only snapshot whose subjects are unknown locally', async () => {
		const permissionsOnly = {
			manifest: { version: 1, resources: ['permissions'] },
			roles: [],
			permissions: VALID_SNAPSHOT.permissions,
		};

		const { remote } = session(() => ({ status: 200, data: { data: permissionsOnly } }));

		await expect(fetchRemoteSnapshot(remote, { manifestVersion: 1, resources: ['permissions'] })).resolves.toEqual(
			permissionsOnly
		);
	});

	it('ignores records under an unmanaged kind and returns that kind empty', async () => {
		const rolesOnly = {
			manifest: { version: 1, resources: ['roles'] },
			roles: VALID_SNAPSHOT.roles,
			permissions: VALID_SNAPSHOT.permissions,
		};

		const { remote } = session(() => ({ status: 200, data: { data: rolesOnly } }));

		await expect(fetchRemoteSnapshot(remote, { manifestVersion: 1, resources: ['roles'] })).resolves.toEqual({
			manifest: { version: 1, resources: ['roles'] },
			roles: VALID_SNAPSHOT.roles,
			permissions: [],
		});
	});

	it('names the failing field in a refused snapshot', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: { data: { ...VALID_SNAPSHOT, roles: [{ ...VALID_SNAPSHOT.roles[0], external_id: 'sso-7' }] } },
		}));

		const error = await caught(() => fetchRemoteSnapshot(remote, scope));

		expect(error.exitCode).toBe(3);

		expect(error.message).toBe(
			'The server returned a malformed snapshot response ("roles[0].external_id" is not allowed).'
		);
	});

	it('scrubs a token longer than the diagnostic bound before truncating', async () => {
		const longToken = 't'.repeat(300);

		const { remote } = session(() => ({
			status: 200,
			data: { data: { ...VALID_SNAPSHOT, roles: [{ ...VALID_SNAPSHOT.roles[0], [longToken]: true }] } },
		}));

		const error = await caught(() => fetchRemoteSnapshot({ ...remote, token: longToken }, scope));

		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('[redacted]');
		expect(error.message).not.toContain('tttttttt');
	});

	it('redacts a control-bearing token from a refused snapshot diagnostic', async () => {
		const token = `sec${BEL}ret`;

		const { remote } = session(() => ({
			status: 200,
			data: { data: { ...VALID_SNAPSHOT, roles: [{ ...VALID_SNAPSHOT.roles[0], [token]: true }] } },
		}));

		const error = await caught(() => fetchRemoteSnapshot({ ...remote, token }, scope));

		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('[redacted]');
		expect(error.message).not.toContain('sec?ret');
		expect(error.message).not.toContain(BEL);
	});

	it('names the placeholder-bearing field in a refused snapshot', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: {
				data: { ...VALID_SNAPSHOT, roles: [{ ...VALID_SNAPSHOT.roles[0], name: '{{CAIRNCMS_CONFIG_SECRET}}' }] },
			},
		}));

		const error = await caught(() => fetchRemoteSnapshot(remote, scope));

		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('malformed snapshot response');
		expect(error.message).toContain('field "name" holds placeholder syntax');
		expect(error.message).not.toContain('CAIRNCMS_CONFIG_SECRET');
	});

	const editor = VALID_SNAPSHOT.roles[0]!;
	const editorSet = VALID_SNAPSHOT.permissions[0]!;
	const rule = editorSet.permissions[0]!;

	it.each([
		['an unknown role field', { roles: [{ ...editor, external_id: 'x' }] }],
		['an unknown permission field', { permissions: [{ ...editorSet, permissions: [{ ...rule, extra: true }] }] }],
		['an unknown permission-set field', { permissions: [{ ...editorSet, note: 'x' }] }],
		['an unknown top-level key', { meta: {} }],
		['a role name over the column length', { roles: [{ ...editor, name: 'n'.repeat(101) }] }],
		['a role key over the column length', { roles: [{ ...editor, key: 'k'.repeat(256) }] }],
		['an empty role key', { roles: [{ ...editor, key: '' }] }],
		['a role key failing the grammar', { roles: [{ ...editor, key: 'Editor Role' }] }],
		['the reserved public role key', { roles: [{ ...editor, key: 'public' }] }],
		['a null role name', { roles: [{ ...editor, name: null }] }],
		['a null icon', { roles: [{ ...editor, icon: null }] }],
		['a role name in placeholder form', { roles: [{ ...editor, name: '{{CAIRNCMS_CONFIG_SECRET}}' }] }],
		['a role description in placeholder form', { roles: [{ ...editor, description: '{{DB_PASSWORD}}' }] }],
		['a duplicate role identity', { roles: [editor, editor] }],
		['two permission sets for one role', { permissions: [editorSet, editorSet] }],
		['a duplicate collection and action in one set', { permissions: [{ ...editorSet, permissions: [rule, rule] }] }],
		[
			'a permission set naming a role the snapshot does not declare',
			{ permissions: [{ ...editorSet, role: 'ghost' }] },
		],
		[
			'a manifest version differing from the request',
			{ manifest: { version: 2, resources: ['roles', 'permissions'] } },
		],
	])('rejects a snapshot with %s at exit 3 before returning', async (_label, overrides) => {
		const { remote } = session(() => ({ status: 200, data: { data: { ...VALID_SNAPSHOT, ...overrides } } }));

		const error = await caught(() => fetchRemoteSnapshot(remote, scope));

		expect(error).toBeInstanceOf(RemoteClientError);
		expect(error.exitCode).toBe(3);
		expect(error.message).toContain('malformed snapshot');
	});

	it('rejects a snapshot missing its roles and permissions at exit 3 before returning', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: { data: { manifest: { version: 1, resources: ['roles', 'permissions'] } } },
		}));

		expect((await caught(() => fetchRemoteSnapshot(remote, scope))).exitCode).toBe(3);
	});

	it('rejects a snapshot whose permission rows are malformed at exit 3', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: {
				data: {
					manifest: { version: 1, resources: ['roles', 'permissions'] },
					roles: [],
					permissions: [{ role: 'editor', permissions: [{ collection: 'articles' }] }],
				},
			},
		}));

		expect((await caught(() => fetchRemoteSnapshot(remote, scope))).exitCode).toBe(3);
	});

	it('rejects a snapshot whose scope does not match the request at exit 3', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: { data: { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] } },
		}));

		expect((await caught(() => fetchRemoteSnapshot(remote, scope))).exitCode).toBe(3);
	});

	it('rejects a snapshot role key that would escape the config directory at exit 3', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: {
				data: {
					manifest: { version: 1, resources: ['roles', 'permissions'] },
					roles: [{ key: '../cairncms-config', name: 'Evil', admin_access: true, app_access: true }],
					permissions: [],
				},
			},
		}));

		expect((await caught(() => fetchRemoteSnapshot(remote, scope))).exitCode).toBe(3);
	});

	it('rejects a snapshot permission row with an unsupported action at exit 3', async () => {
		const { remote } = session(() => ({
			status: 200,
			data: {
				data: {
					manifest: { version: 1, resources: ['roles', 'permissions'] },
					roles: [],
					permissions: [
						{
							role: 'editor',
							permissions: [
								{
									collection: 'articles',
									action: 'frobnicate',
									permissions: null,
									validation: null,
									presets: null,
									fields: null,
								},
							],
						},
					],
				},
			},
		}));

		expect((await caught(() => fetchRemoteSnapshot(remote, scope))).exitCode).toBe(3);
	});
});

function assertThrow(fn: () => void): RemoteClientError {
	try {
		fn();
	} catch (err) {
		return err as RemoteClientError;
	}

	throw new Error('expected a throw');
}
