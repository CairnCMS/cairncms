import type { Accountability, ExtensionCapabilities } from '@cairncms/types';
import { createConfinedHostBroker, DARK_SETTINGS, type ConfinedHostBrokerDeps, type ConfinedLogEntry } from './broker.js';
import { toConfinedAccountability } from './operation.js';
import { ConfinedSecretScope } from './secret-scope.js';
import type { ConfinedHostDispatcher, ConfinedInvocation, ConfinedResult, ConfinedRuntimeLimits } from './types.js';

export const ENDPOINT_PATH_MAX = 2048;
export const ENDPOINT_QUERY_KEYS_MAX = 64;
export const ENDPOINT_QUERY_VALUE_MAX = 2048;
export const ENDPOINT_BODY_BYTES_MAX = 1024 * 1024;

const ENDPOINT_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export interface ConfinedEndpointRequest {
	extensionId: string;
	// The endpoint contribution id, which is also the route name and the entry's
	// declared identity.
	contributionId: string;
	// The gate-probed built server entry bytes. Executed as bytes, never imported.
	entrySource: string;
	capabilities: ExtensionCapabilities;
	// The inbound HTTP request, body already parsed and bounded by the platform.
	method: string;
	path: string;
	query: unknown;
	body: unknown;
	accountability: Accountability | null;
}

export interface ConfinedEndpointDeps {
	// The supervisor run seam: spawns the child and brokers its host calls.
	invoke: (invocation: ConfinedInvocation, dispatcher: ConfinedHostDispatcher) => Promise<ConfinedResult>;
	// The platform log sink. The broker redacts before this is called.
	log: (entry: ConfinedLogEntry) => void;
	getAxios?: ConfinedHostBrokerDeps['getAxios'];
	itemsService?: ConfinedHostBrokerDeps['itemsService'];
	brokerLimits: ConfinedHostBrokerDeps['limits'];
	runtimeLimits: ConfinedRuntimeLimits;
}

/**
 * The runner's sanitized verdict. The binding maps a failure to the platform
 * error shape, so a guest message or detail never reaches the HTTP response.
 */
export type ConfinedEndpointResult =
	| { ok: true; status: number; body: unknown }
	| { ok: false; failure: 'unauthenticated' | 'denied' | 'invalid-request' | 'internal' };

function shapeQuery(raw: unknown): Record<string, string> | null {
	if (raw === null || raw === undefined) return Object.create(null);
	if (typeof raw !== 'object' || Array.isArray(raw)) return null;

	const entries = Object.entries(raw);
	if (entries.length > ENDPOINT_QUERY_KEYS_MAX) return null;

	const query: Record<string, string> = Object.create(null);

	for (const [key, value] of entries) {
		if (key.length > ENDPOINT_QUERY_VALUE_MAX) return null;
		if (typeof value !== 'string' || value.length > ENDPOINT_QUERY_VALUE_MAX) return null;
		query[key] = value;
	}

	return query;
}

function shapeBody(raw: unknown): { ok: true; body: unknown } | { ok: false } {
	if (raw === undefined) return { ok: true, body: null };

	let serialized: string;

	try {
		serialized = JSON.stringify(raw) ?? 'null';
	} catch {
		return { ok: false };
	}

	if (Buffer.byteLength(serialized, 'utf8') > ENDPOINT_BODY_BYTES_MAX) return { ok: false };

	return { ok: true, body: raw ?? null };
}

function shapeGuestResult(value: unknown, method: string): ConfinedEndpointResult {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, failure: 'internal' };

	// Only `status` and `body` exist in the result contract. An unknown key, such
	// as headers or cookies, refuses loudly rather than being silently dropped.
	for (const key of Object.keys(value)) {
		if (key !== 'status' && key !== 'body') return { ok: false, failure: 'internal' };
	}

	const record = value as { status?: unknown; body?: unknown };
	const status = record.status === undefined ? 200 : record.status;

	if (typeof status !== 'number' || !Number.isSafeInteger(status) || status < 100 || status > 599) {
		return { ok: false, failure: 'internal' };
	}

	return { ok: true, status, body: method === 'HEAD' ? null : record.body ?? null };
}

/**
 * Runs a confined JSON endpoint. The authority gate is decided before any child
 * exists: an undeclared endpoint capability denies, and `authenticated` access
 * requires a caller with a user. The inbound request is shaped and bounded before
 * the parent materializes it into a child frame, the guest receives only
 * `{ method, path, query, body }`, and the guest's reply is held to the result
 * contract: a `status` in 100 to 599, a JSON `body`, and nothing else.
 */
export async function runConfinedEndpoint(
	request: ConfinedEndpointRequest,
	deps: ConfinedEndpointDeps
): Promise<ConfinedEndpointResult> {
	const access = request.capabilities.endpoint?.access;

	if (access === undefined) return { ok: false, failure: 'denied' };

	if (access === 'authenticated' && !request.accountability?.user) {
		return { ok: false, failure: 'unauthenticated' };
	}

	const method = typeof request.method === 'string' ? request.method.toUpperCase() : '';
	if (!ENDPOINT_METHODS.has(method)) return { ok: false, failure: 'invalid-request' };

	if (typeof request.path !== 'string' || request.path.length > ENDPOINT_PATH_MAX || !request.path.startsWith('/')) {
		return { ok: false, failure: 'invalid-request' };
	}

	const query = shapeQuery(request.query);
	if (query === null) return { ok: false, failure: 'invalid-request' };

	const body = shapeBody(request.body);
	if (!body.ok) return { ok: false, failure: 'invalid-request' };

	try {
		const scope = new ConfinedSecretScope();

		const brokerDeps: ConfinedHostBrokerDeps = {
			capabilities: request.capabilities,
			log: deps.log,
			settings: DARK_SETTINGS,
			accountability: request.accountability,
			limits: deps.brokerLimits,
			// Endpoints mint no option handles, so no reference ever resolves.
			resolveSecret: async () => null,
		};

		if (deps.getAxios !== undefined) brokerDeps.getAxios = deps.getAxios;
		if (deps.itemsService !== undefined) brokerDeps.itemsService = deps.itemsService;

		const dispatcher = createConfinedHostBroker(brokerDeps, scope);

		const invocation: ConfinedInvocation = {
			extensionId: request.extensionId,
			contributionId: request.contributionId,
			operationId: request.contributionId,
			activation: 'json-endpoint',
			entrySource: request.entrySource,
			options: {},
			input: { method, path: request.path, query, body: body.body },
			accountability: toConfinedAccountability(request.accountability),
			limits: deps.runtimeLimits,
		};

		const result = await deps.invoke(invocation, dispatcher);

		if (!result.ok) return { ok: false, failure: 'internal' };

		return shapeGuestResult(result.value, method);
	} catch {
		return { ok: false, failure: 'internal' };
	}
}
