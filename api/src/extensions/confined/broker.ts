import type { ExtensionCapabilities } from '@cairncms/types';
import { collectSensitiveValues, redactFlowLog } from '../../utils/redact-flow-log.js';
import type { ConfinedSecretScope } from './secret-scope.js';
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

export interface ConfinedHostBrokerDeps {
	// The gate-validated capabilities for this invocation's contribution.
	capabilities: ExtensionCapabilities;
	// The platform log sink. Input arrives fully redacted.
	log(entry: ConfinedLogEntry): void;
	settings: ConfinedSettingsSource;
	limits: { settingsValueBytes: number };
}

function denied(message: string): ConfinedHostReply {
	return { ok: false, error: { code: 'denied', message } };
}

function unsupported(): ConfinedHostReply {
	return { ok: false, error: { code: 'unsupported', message: 'host method is not supported' } };
}

function invalidRequest(message: string): ConfinedHostReply {
	return { ok: false, error: { code: 'invalid_request', message } };
}

const ABORTED = Symbol('aborted');

function timedOut(): ConfinedHostReply {
	return { ok: false, error: { code: 'timeout', message: 'the host call timed out' } };
}

/**
 * Races a dependency call against the per-call abort signal, so the broker
 * settles at the call timeout even when the dependency ignores its signal and
 * never resolves. An unsettled dispatcher promise would otherwise pin the
 * supervisor's in-flight accounting indefinitely.
 */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
	if (signal.aborted) return Promise.resolve(ABORTED);

	return new Promise((resolve, reject) => {
		const onAbort = () => resolve(ABORTED);
		signal.addEventListener('abort', onAbort, { once: true });

		work.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			}
		);
	});
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

	return async (call: ConfinedHostCall, context: ConfinedHostCallContext, signal: AbortSignal) => {
		if (signal.aborted) return timedOut();

		const level = LOG_LEVELS[call.method];
		if (level !== undefined) return serveLog(level, call.args, context);

		if (call.method === 'settings.get') return serveSettingsGet(call.args, context, signal);

		return unsupported();
	};
}
