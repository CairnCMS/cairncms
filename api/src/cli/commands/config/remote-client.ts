import type { AxiosInstance, Method } from 'axios';
import { isPlainObject } from 'lodash-es';
import type { CairnConfig, ConfigKind } from '../../../types/config.js';
import { replaceControlCharacters } from '../../../utils/safe-log-fragment.js';
import { resolveEndpoint, type OperatorRemoteTarget } from './operator-remote-target.js';
import { RemoteApplyResult, RemoteConfigPlan, RemoteSnapshot } from './remote-response-schema.js';

export const REMOTE_CONFIG_MIN_VERSION = '1.6.0';

const PLAN_VERSION = 2;

const UNKNOWN_OUTCOME_NOTE =
	' The server may have already applied the change; re-snapshot to verify the current state.';

export class RemoteClientError extends Error {
	readonly exitCode: 2 | 3;

	constructor(message: string, exitCode: 2 | 3) {
		super(message);
		this.exitCode = exitCode;
	}
}

export type RemoteSession = {
	transport: AxiosInstance;
	target: OperatorRemoteTarget;
	token: string;
};

type Envelope = { data: unknown; meta: unknown };

async function request(
	session: RemoteSession,
	method: Method,
	endpoint: string,
	options: { query?: Record<string, string>; body?: unknown; mutating?: boolean } = {}
): Promise<Envelope> {
	const url = resolveEndpoint(session.target, endpoint);
	const outcome = options.mutating ? UNKNOWN_OUTCOME_NOTE : '';

	let response;

	try {
		response = await session.transport.request({
			method,
			url: url.href,
			headers: { Authorization: `Bearer ${session.token}` },
			params: options.query,
			data: options.body,
			responseType: 'json',
			validateStatus: () => true,
		});
	} catch (err) {
		throw new RemoteClientError(
			`Could not reach the server: ${sanitize(transportMessage(err), session.token)}.${outcome}`,
			3
		);
	}

	if (response.status < 200 || response.status >= 300) {
		const preCommitRefusal = response.status >= 400 && response.status < 500;
		const label = response.status >= 400 ? 'rejected the request' : 'returned an unexpected redirect';

		throw new RemoteClientError(
			`The server ${label} (${response.status}): ${sanitize(serverErrorMessage(response.data), session.token)}${
				preCommitRefusal ? '' : outcome
			}`,
			preCommitRefusal ? 2 : 3
		);
	}

	if (!isPlainObject(response.data)) {
		throw new RemoteClientError(`The server returned a response that was not valid JSON.${outcome}`, 3);
	}

	return {
		data: (response.data as Record<string, unknown>)['data'],
		meta: (response.data as Record<string, unknown>)['meta'],
	};
}

export async function fetchServerVersion(session: RemoteSession): Promise<string> {
	const { data } = await request(session, 'GET', 'server/info');
	const version = isPlainObject(data) ? (data as any).cairncms?.version : undefined;

	if (typeof version !== 'string' || version.length === 0) {
		throw new RemoteClientError('The server did not report a version; the token may lack admin access.', 3);
	}

	return version;
}

export function assertServerSupportsRemoteConfig(version: string, token: string): void {
	const shown = sanitize(version, token);
	let ok: boolean;

	try {
		ok = meetsMinVersion(version, REMOTE_CONFIG_MIN_VERSION);
	} catch {
		throw new RemoteClientError(`The server reported an unrecognized version "${shown}".`, 3);
	}

	if (!ok) {
		throw new RemoteClientError(
			`The server is version ${shown}; remote config requires ${REMOTE_CONFIG_MIN_VERSION} or newer.`,
			2
		);
	}
}

export async function fetchRemoteSnapshot(
	session: RemoteSession,
	scope: { manifestVersion: number; resources: readonly ConfigKind[] }
): Promise<CairnConfig> {
	const { data } = await request(session, 'GET', 'config/snapshot', {
		query: { manifest_version: String(scope.manifestVersion), resources: scope.resources.join(',') },
	});

	if (!RemoteSnapshot.safeParse(data).success) throw malformed('snapshot');

	assertSnapshotShape(data, scope);

	return data as CairnConfig;
}

export async function applyRemote(
	session: RemoteSession,
	body: unknown,
	options: { dryRun: boolean; destructive: boolean }
): Promise<{ plan: unknown; result?: unknown }> {
	const query: Record<string, string> = {};
	if (options.dryRun) query['dry_run'] = 'true';
	if (options.destructive) query['destructive'] = 'true';

	const { data, meta } = await request(session, 'POST', 'config/apply', { query, body, mutating: !options.dryRun });

	if (options.dryRun) {
		assertPlanShape(data);
		return { plan: data };
	}

	try {
		assertResultShape(data);
		const plan = isPlainObject(meta) ? (meta as Record<string, unknown>)['plan'] : undefined;
		assertPlanShape(plan);

		return { plan, result: data };
	} catch (err) {
		if (err instanceof RemoteClientError)
			throw new RemoteClientError(`${err.message}${UNKNOWN_OUTCOME_NOTE}`, err.exitCode);
		throw err;
	}
}

function assertPlanShape(plan: unknown): void {
	if (isPlainObject(plan)) {
		const declared = (plan as Record<string, unknown>)['planVersion'];

		if (declared !== undefined && declared !== PLAN_VERSION) {
			throw new RemoteClientError('The server returned an unsupported plan version.', 3);
		}
	}

	if (!RemoteConfigPlan.safeParse(plan).success) throw malformed('plan');
}

function assertResultShape(result: unknown): void {
	if (!RemoteApplyResult.safeParse(result).success) throw malformed('result');
}

function assertSnapshotShape(
	data: unknown,
	scope: { manifestVersion: number; resources: readonly ConfigKind[] }
): void {
	if (!isPlainObject(data)) throw malformed('snapshot');

	const manifest = (data as Record<string, unknown>)['manifest'];

	if (!isPlainObject(manifest) || (manifest as Record<string, unknown>)['version'] !== scope.manifestVersion) {
		throw malformed('snapshot manifest version');
	}

	const returned = (manifest as Record<string, unknown>)['resources'];

	if (!Array.isArray(returned) || !sameKinds(returned, scope.resources)) {
		throw malformed('snapshot scope');
	}
}

function sameKinds(returned: unknown[], requested: readonly ConfigKind[]): boolean {
	if (returned.length !== requested.length) return false;
	const set = new Set(returned);
	return requested.every((kind) => set.has(kind));
}

function malformed(what: string): RemoteClientError {
	return new RemoteClientError(`The server returned a malformed ${what} response.`, 3);
}

function sanitize(text: string, token: string): string {
	const redacted = token.length > 0 ? text.split(token).join('[redacted]') : text;
	return replaceControlCharacters(redacted);
}

function serverErrorMessage(data: unknown): string {
	if (isPlainObject(data) && Array.isArray((data as Record<string, unknown>)['errors'])) {
		const errors = (data as { errors: Array<{ message?: unknown }> }).errors;
		const message = errors[0]?.message;
		if (typeof message === 'string' && message.length > 0) return message;
	}

	return 'no error detail was provided.';
}

function transportMessage(err: unknown): string {
	const code = (err as { code?: unknown }).code;
	if (typeof code === 'string' && code.length > 0) return code;

	const message = (err as { message?: unknown }).message;
	return typeof message === 'string' && message.length > 0 ? message : 'the connection failed.';
}

function meetsMinVersion(version: string, floor: string): boolean {
	const current = parseVersion(version);
	const [cMajor, cMinor, cPatch] = current.release;
	const [mMajor, mMinor, mPatch] = parseVersion(floor).release;

	if (cMajor !== mMajor) return cMajor > mMajor;
	if (cMinor !== mMinor) return cMinor > mMinor;
	if (cPatch !== mPatch) return cPatch > mPatch;

	return !current.prerelease;
}

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parseVersion(version: string): { release: [number, number, number]; prerelease: boolean } {
	const match = SEMVER.exec(version);
	if (!match) throw new Error('malformed version');

	const release = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];

	for (const component of release) {
		if (!Number.isSafeInteger(component)) throw new Error('malformed version');
	}

	return { release, prerelease: match[4] !== undefined };
}
