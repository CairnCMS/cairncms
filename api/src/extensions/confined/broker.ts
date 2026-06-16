import type { Accountability, ExtensionCapabilities } from '@cairncms/types';
import type { AxiosInstance } from 'axios';
import { collectSensitiveValues, redactFlowLog } from '../../utils/redact-flow-log.js';
import { redactionFallback, scrubString } from '../../utils/scrub-string.js';
import { createConfinedItemsHost, type ConfinedItemsServiceFactory } from './host-items.js';
import { ABORTED, abortable, denied, invalidRequest, timedOut, unsupported } from './host-reply.js';
import { createConfinedTemplateHost } from './host-template.js';
import type { ConfinedSecretBinding, ConfinedSecretScope } from './secret-scope.js';
import type { ConfinedHostCall, ConfinedHostCallContext, ConfinedHostDispatcher, ConfinedHostReply } from './types.js';

export type ConfinedLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ConfinedLogEntry {
	level: ConfinedLogLevel;
	message: unknown;
	meta?: unknown;
	context: ConfinedHostCallContext;
}

// The settings contract the broker consumes. Declared keys and their sensitivity
// come from this dep, never from guest input and never from the capability schema,
// which carries only the read and write verbs. The value source must return values
// already bounded by the settings-value cap, and the broker checks defensively.
export interface ConfinedSettingsSource {
	declared: Array<{ key: string; sensitive: boolean }>;
	// The signal is the per-call timeout. A storage-backed source must honor it, and
	// the broker additionally races it, so an unresponsive source cannot pin the
	// supervisor's in-flight accounting past the call timeout.
	value(key: string, signal: AbortSignal): unknown | Promise<unknown>;
	hasSecret(key: string, signal: AbortSignal): boolean | Promise<boolean>;
}

// Settings ship dark in this milestone: no key is declared, so settings.get always
// returns null and mints no handle. A later slice defines declaration and storage.
export const DARK_SETTINGS: ConfinedSettingsSource = {
	declared: [],
	value: () => null,
	hasSecret: () => false,
};

export interface ConfinedHostBrokerDeps {
	// The gate-validated capabilities for this invocation's contribution.
	capabilities: ExtensionCapabilities;
	// The platform log sink. Input arrives fully redacted.
	log(entry: ConfinedLogEntry): void;
	settings: ConfinedSettingsSource;
	// The shared validated HTTP client. SSRF and IP deny-list enforcement live in
	// the client at the connection boundary, the broker's allowlists sit above it.
	getAxios?: () => Promise<AxiosInstance>;
	// Resolves a secret binding to its real value at the moment of brokered use.
	// Absent means no brokered-use path is wired, and auth requests are denied.
	resolveSecret?: (binding: ConfinedSecretBinding, signal: AbortSignal) => Promise<string | null>;
	// The invocation's accountability, carried explicitly for the current-user
	// items mode. Absent and null both deny, never elevate.
	accountability?: Accountability | null;
	// Constructs the read service under the resolved authority. Absent means no
	// brokered items path is wired, and items calls are denied.
	itemsService?: ConfinedItemsServiceFactory;
	limits: {
		settingsValueBytes: number;
		httpResponseBytes: number;
		itemsReplyBytes: number;
		templateOutputBytes: number;
	};
}

// Conservative outbound timeout bounds. The per-call host timeout still races
// every request through the abort signal.
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 30_000;

// RFC 7230 header field-name token.
const HEADER_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

// Header names the guest and the brokered-auth target may never set: authority
// and routing headers, hop-by-hop headers, and proxy metadata.
const FORBIDDEN_HEADER_NAMES = new Set([
	'host',
	'connection',
	'keep-alive',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
	'content-length',
	'forwarded',
]);

function isForbiddenHeaderName(name: string): boolean {
	const lowered = name.toLowerCase();
	return FORBIDDEN_HEADER_NAMES.has(lowered) || lowered.startsWith('x-forwarded-') || lowered.startsWith('proxy-');
}

/**
 * The origin an allowlist entry grants, or null when the entry grants nothing.
 * An entry must be a bare http or https origin: unparseable entries, non-http
 * schemes, credentials, paths beyond `/`, queries, fragments, and trailing-dot
 * hosts all match nothing, as runtime defense in depth beneath the schema's
 * origin-only validation.
 */
export function originForAllowlistEntry(entry: string): string | null {
	let url: URL;

	try {
		url = new URL(entry);
	} catch {
		return null;
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username !== '' || url.password !== '') return null;
	if (url.hostname.endsWith('.')) return null;
	if (url.pathname !== '/' && url.pathname !== '') return null;
	if (url.search !== '' || url.hash !== '') return null;

	return url.origin;
}

/**
 * The origin of a request url, or null when the url is outside the contract:
 * unparseable, non-http scheme, carrying credentials, or a trailing-dot host.
 * `URL.origin` lowercases the host and drops default ports, so the comparison
 * is exact equality on the canonical form.
 */
export function originForRequestUrl(rawUrl: string): string | null {
	let url: URL;

	try {
		url = new URL(rawUrl);
	} catch {
		return null;
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
	if (url.username !== '' || url.password !== '') return null;
	if (url.hostname.endsWith('.')) return null;

	return url.origin;
}

const LOG_LEVELS: Record<string, ConfinedLogLevel> = {
	'log.debug': 'debug',
	'log.info': 'info',
	'log.warn': 'warn',
	'log.error': 'error',
};

/**
 * The parent-side host API broker, the only authority door. Every effect is
 * capability-checked against the gate-validated declaration, performed parent-side,
 * and replied as a JSON-safe value with every secret and sensitive value redacted
 * before it can reach a platform sink. Effects arrive as injected dependencies, so
 * the broker holds no platform state and re-checks nothing per call.
 */
export function createConfinedHostBroker(
	deps: ConfinedHostBrokerDeps,
	scope: ConfinedSecretScope
): ConfinedHostDispatcher {
	// One normalized view of the declarations, read by both the redaction set and
	// the settings lookup, so the two can never disagree. Keys collapse to lowercase
	// because the redaction path matches keys case-insensitively, and duplicates
	// (exact or case-variant) take the most restrictive interpretation: sensitive if
	// any duplicate says so. Conflicting declarations therefore cannot open a
	// raw-value path that redaction closed, regardless of how a backing store
	// treats key case.
	const declaredByKey = new Map<string, { sensitive: boolean }>();

	for (const entry of deps.settings.declared) {
		const lowered = entry.key.toLowerCase();
		const existing = declaredByKey.get(lowered);
		declaredByKey.set(lowered, { sensitive: entry.sensitive || existing?.sensitive === true });
	}

	const sensitiveKeys = new Set(
		[...declaredByKey.entries()].filter(([, entry]) => entry.sensitive).map(([key]) => key)
	);

	// The granted origins, fixed per invocation from the gate-validated capability.
	const allowedOrigins = new Set(
		(deps.capabilities.request?.urls ?? [])
			.map(originForAllowlistEntry)
			.filter((origin): origin is string => origin !== null)
	);

	const allowedMethods = new Set((deps.capabilities.request?.methods ?? ['GET']).map((method) => method.toUpperCase()));

	const itemsHost = createConfinedItemsHost({
		capabilities: deps.capabilities,
		accountability: deps.accountability,
		itemsService: deps.itemsService,
		itemsReplyBytes: deps.limits.itemsReplyBytes,
	});

	const templateHost = createConfinedTemplateHost({
		capabilities: deps.capabilities,
		templateOutputBytes: deps.limits.templateOutputBytes,
	});

	function serveLog(level: ConfinedLogLevel, args: unknown, context: ConfinedHostCallContext): ConfinedHostReply {
		if (deps.capabilities.log !== true) {
			return denied('the log capability is not declared');
		}

		const record = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
		const payload = { message: record['message'], meta: record['meta'] };

		// Redaction layering before the sink: values under declared-sensitive keys
		// (value propagation included), the scope tokens, and any resolved secrets.
		const sensitiveValues = collectSensitiveValues(payload, sensitiveKeys);
		for (const value of scope.redactionValues()) sensitiveValues.add(value);

		const redacted = redactFlowLog(payload, sensitiveValues, sensitiveKeys);

		deps.log({ level, message: redacted.message, meta: redacted.meta, context });

		return { ok: true, value: null };
	}

	async function serveSettingsGet(
		args: unknown,
		context: ConfinedHostCallContext,
		signal: AbortSignal
	): Promise<ConfinedHostReply> {
		if (!deps.capabilities.settings?.includes('read')) {
			return denied('the settings read capability is not declared');
		}

		const key = args !== null && typeof args === 'object' ? (args as Record<string, unknown>)['key'] : undefined;

		if (typeof key !== 'string' || key.length === 0) {
			return invalidRequest('settings.get requires a key');
		}

		const declared = declaredByKey.get(key.toLowerCase());

		// Declared keys are the whole vocabulary. An undeclared key is null, never an
		// error, so a guest cannot probe which keys exist beyond its own declaration.
		if (declared === undefined) {
			return { ok: true, value: null };
		}

		if (declared.sensitive) {
			// A sensitive setting never crosses as a value. A fresh per-call reference is
			// minted when a backing secret exists, so a token cannot be replayed across
			// calls and the redaction set always knows it.
			const exists = await abortable(Promise.resolve(deps.settings.hasSecret(key, signal)), signal);
			if (exists === ABORTED) return timedOut();
			if (!exists) return { ok: true, value: null };

			const ref = scope.mint({
				kind: 'extension-setting',
				extensionId: context.extensionId,
				contributionId: context.contributionId,
				key,
			});

			return { ok: true, value: { kind: 'secret-reference', ref } };
		}

		const value = await abortable(Promise.resolve(deps.settings.value(key, signal)), signal);
		if (value === ABORTED) return timedOut();

		let size: number;

		try {
			size = Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
		} catch {
			return { ok: false, error: { code: 'internal', message: 'the setting value is not serializable' } };
		}

		if (size > deps.limits.settingsValueBytes) {
			return invalidRequest('the setting value exceeds the size cap');
		}

		return { ok: true, value: value === undefined ? null : value };
	}

	/**
	 * Resolves a brokered-auth declaration into the header the broker owns. The
	 * validation order is load-bearing: smuggling was already denied before this
	 * runs, then the auth shape, the scope resolution, the cross-owner check, the
	 * header-name safety, and only then the abort-aware secret resolution.
	 */
	async function resolveAuth(
		auth: unknown,
		sanitizedHeaders: Record<string, string>,
		context: ConfinedHostCallContext,
		signal: AbortSignal
	): Promise<{ ok: true; name: string; value: string } | { ok: false; reply: ConfinedHostReply }> {
		const fail = (reply: ConfinedHostReply) => ({ ok: false as const, reply });

		const shape = readAuthShape(auth);
		if (shape === null) return fail(denied('the auth declaration is not valid'));

		const binding = scope.resolve(shape.ref);
		if (binding === undefined) return fail(denied('the secret reference is not valid'));

		if (binding.kind === 'flow-operation-option') {
			if (binding.operationId !== context.operationId) return fail(denied('the secret reference is not valid'));
		} else if (binding.kind === 'extension-setting') {
			if (binding.extensionId !== context.extensionId || binding.contributionId !== context.contributionId) {
				return fail(denied('the secret reference is not valid'));
			}
		} else {
			return fail(denied('the secret reference is not valid'));
		}

		const name = shape.kind === 'bearer' ? 'Authorization' : shape.header;

		if (!HEADER_NAME_TOKEN.test(name) || isForbiddenHeaderName(name)) {
			return fail(denied('the auth header name is not allowed'));
		}

		const lowered = name.toLowerCase();

		if (Object.keys(sanitizedHeaders).some((existing) => existing.toLowerCase() === lowered)) {
			return fail(denied('the auth header collides with a request header'));
		}

		if (deps.resolveSecret === undefined) return fail(denied('brokered auth is not available'));

		let secret: string | null | typeof ABORTED;

		try {
			secret = await abortable(deps.resolveSecret(binding, signal), signal);
		} catch {
			return fail({ ok: false, error: { code: 'internal', message: 'the host call failed' } });
		}

		if (secret === ABORTED) return fail(timedOut());
		if (secret === null || secret === '') return fail(denied('the secret reference is not valid'));

		scope.registerResolved(secret);

		return { ok: true, name, value: shape.kind === 'bearer' ? `Bearer ${secret}` : secret };
	}

	async function serveRequest(
		args: unknown,
		context: ConfinedHostCallContext,
		signal: AbortSignal
	): Promise<ConfinedHostReply> {
		if (deps.capabilities.request === undefined) {
			return denied('the request capability is not declared');
		}

		const record = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};
		const rawUrl = record['url'];

		if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
			return invalidRequest('request.send requires a url');
		}

		// A scope token is accepted in the auth field and nowhere else, so a handle
		// smuggled through the url, a header, or the body is denied before anything
		// is resolved.
		if (containsSmuggledRef(rawUrl, record['headers'], record['body'])) {
			return invalidRequest('a secret reference is only accepted in the auth declaration');
		}

		const origin = originForRequestUrl(rawUrl);
		if (origin === null) return invalidRequest('the request url is not valid');
		if (!allowedOrigins.has(origin)) return denied('the request url is not in the declared allowlist');

		const rawMethod = record['method'] ?? 'GET';
		if (typeof rawMethod !== 'string') return invalidRequest('the request method is not valid');

		const method = rawMethod.toUpperCase();
		if (!allowedMethods.has(method)) return denied('the request method is not in the declared allowlist');

		const headers = sanitizeRequestHeaders(record['headers']);

		if (record['auth'] !== undefined) {
			const auth = await resolveAuth(record['auth'], headers, context, signal);
			if (!auth.ok) return auth.reply;
			headers[auth.name] = auth.value;
		}

		if (deps.getAxios === undefined) return denied('outbound requests are not available');

		const requestedTimeout = record['timeoutMs'];

		const timeout = Math.min(
			typeof requestedTimeout === 'number' && Number.isFinite(requestedTimeout) && requestedTimeout > 0
				? requestedTimeout
				: DEFAULT_REQUEST_TIMEOUT_MS,
			MAX_REQUEST_TIMEOUT_MS
		);

		let response: { status: number; headers: unknown; data: unknown };

		// Both the client factory and the request itself are abort-raced: the signal
		// goes into the request config for a well-behaved client, and the race
		// guarantees the broker settles at the call timeout even when an injected
		// client ignores it, so the in-flight slot cannot leak.
		try {
			const client = await abortable(deps.getAxios(), signal);
			if (client === ABORTED) return timedOut();

			const result = await abortable(
				client.request({
					url: rawUrl,
					method,
					headers,
					data: record['body'],
					timeout,
					maxRedirects: 0,
					maxContentLength: deps.limits.httpResponseBytes,
					maxBodyLength: deps.limits.httpResponseBytes,
					signal,
					validateStatus: () => true,
				}),
				signal
			);

			if (result === ABORTED) return timedOut();
			response = result;
		} catch (error) {
			return mapRequestError(error, signal);
		}

		const secrets = scope.resolvedSecrets();

		const payload = {
			status: response.status,
			headers: scrubHeaderRecord(normalizeResponseHeaders(response.headers), secrets),
			body: scrubValue(response.data, secrets),
		};

		// The surface cap is a bound on the serialized reply value, so passing here
		// guarantees passing the chokepoint.
		let size: number;

		try {
			size = Buffer.byteLength(JSON.stringify(payload) ?? 'null', 'utf8');
		} catch {
			return { ok: false, error: { code: 'internal', message: 'the response is not serializable' } };
		}

		if (size > deps.limits.httpResponseBytes) {
			return invalidRequest('the response exceeds the response cap');
		}

		return { ok: true, value: payload };
	}

	function containsSmuggledRef(url: string, headers: unknown, body: unknown): boolean {
		if (scope.containsRef(url)) return true;

		if (headers !== null && typeof headers === 'object') {
			for (const [name, value] of Object.entries(headers)) {
				if (scope.containsRef(name) || (typeof value === 'string' && scope.containsRef(value))) return true;
			}
		}

		if (body !== undefined) {
			try {
				const serialized = JSON.stringify(body);
				if (typeof serialized === 'string' && scope.containsRef(serialized)) return true;
			} catch {
				return true;
			}
		}

		return false;
	}

	return async (call: ConfinedHostCall, context: ConfinedHostCallContext, signal: AbortSignal) => {
		if (signal.aborted) return timedOut();

		const level = LOG_LEVELS[call.method];
		if (level !== undefined) return serveLog(level, call.args, context);

		if (call.method === 'settings.get') return serveSettingsGet(call.args, context, signal);

		if (call.method === 'request.send') return serveRequest(call.args, context, signal);

		if (call.method === 'items.read') return itemsHost.read(call.args, signal);

		if (call.method === 'items.readOne') return itemsHost.readOne(call.args, signal);

		if (call.method === 'template.renderLiquid') return templateHost.renderLiquid(call.args, signal);

		return unsupported();
	};
}

/**
 * The auth declaration: exactly one of a bearer handle or a named header plus a
 * handle, both over a `{ kind: 'secret-reference', ref }` value. Anything else,
 * including both forms at once, is invalid.
 */
function readAuthShape(
	auth: unknown
): { kind: 'bearer'; ref: string } | { kind: 'header'; header: string; ref: string } | null {
	if (auth === null || typeof auth !== 'object') return null;

	const record = auth as Record<string, unknown>;
	const hasBearer = record['bearer'] !== undefined;
	const hasHeader = record['header'] !== undefined || record['secret'] !== undefined;

	if (hasBearer && hasHeader) return null;

	if (hasBearer) {
		const ref = readSecretReference(record['bearer']);
		return ref === null ? null : { kind: 'bearer', ref };
	}

	if (typeof record['header'] !== 'string' || record['header'].length === 0) return null;

	const ref = readSecretReference(record['secret']);
	return ref === null ? null : { kind: 'header', header: record['header'], ref };
}

function readSecretReference(value: unknown): string | null {
	if (value === null || typeof value !== 'object') return null;
	const record = value as Record<string, unknown>;

	if (record['kind'] !== 'secret-reference' || typeof record['ref'] !== 'string' || record['ref'].length === 0) {
		return null;
	}

	return record['ref'];
}

/** Keeps only string-valued headers with valid, non-forbidden names. */
function sanitizeRequestHeaders(headers: unknown): Record<string, string> {
	const sanitized: Record<string, string> = {};

	if (headers === null || typeof headers !== 'object') return sanitized;

	for (const [name, value] of Object.entries(headers)) {
		if (typeof value !== 'string') continue;
		if (!HEADER_NAME_TOKEN.test(name) || isForbiddenHeaderName(name)) continue;
		sanitized[name] = value;
	}

	return sanitized;
}

function normalizeResponseHeaders(headers: unknown): Record<string, string> {
	const normalized: Record<string, string> = {};

	if (headers === null || typeof headers !== 'object') return normalized;

	for (const [name, value] of Object.entries(headers)) {
		if (typeof value === 'string') normalized[name] = value;
		else if (Array.isArray(value)) normalized[name] = value.map(String).join(', ');
		else if (value !== null && value !== undefined) normalized[name] = String(value);
	}

	return normalized;
}

function scrubHeaderRecord(headers: Record<string, string>, secrets: string[]): Record<string, string> {
	if (secrets.length === 0) return headers;

	const scrubbed: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) scrubbed[name] = scrubString(value, secrets);
	return scrubbed;
}

/**
 * Scrubs resolved secret values from a response body. String bodies are
 * substring-scrubbed, JSON bodies are scrubbed through their serialized form,
 * and binary bodies are replaced whole rather than scanned.
 */
function scrubValue(value: unknown, secrets: string[]): unknown {
	if (secrets.length === 0) return value;
	if (typeof value === 'string') return scrubString(value, secrets);
	if (value === null || value === undefined || typeof value !== 'object') return value;

	if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
		return redactionFallback(secrets);
	}

	try {
		const serialized = JSON.stringify(value);
		if (typeof serialized !== 'string') return value;
		const scrubbed = scrubString(serialized, secrets);
		return scrubbed === serialized ? value : JSON.parse(scrubbed);
	} catch {
		return redactionFallback(secrets);
	}
}

/** Maps a transport failure to a sanitized reply that never echoes config, urls, or headers. */
function mapRequestError(error: unknown, signal: AbortSignal): ConfinedHostReply {
	const code = error !== null && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
	const message = error instanceof Error ? error.message : '';

	if (signal.aborted || code === 'ECONNABORTED' || code === 'ERR_CANCELED') return timedOut();

	if (code === 'ERR_BAD_RESPONSE' && message.includes('maxContentLength')) {
		return invalidRequest('the response exceeds the response cap');
	}

	return { ok: false, error: { code: 'internal', message: 'the request failed' } };
}
