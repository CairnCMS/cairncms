import type { ConfinedHostReply } from './types.js';

export function denied(message: string): ConfinedHostReply {
	return { ok: false, error: { code: 'denied', message } };
}

export function unsupported(): ConfinedHostReply {
	return { ok: false, error: { code: 'unsupported', message: 'host method is not supported' } };
}

export function invalidRequest(message: string): ConfinedHostReply {
	return { ok: false, error: { code: 'invalid_request', message } };
}

export function timedOut(): ConfinedHostReply {
	return { ok: false, error: { code: 'timeout', message: 'the host call timed out' } };
}

export const ABORTED = Symbol('aborted');

/**
 * Races a dependency call against the per-call abort signal, so the broker
 * settles at the call timeout even when the dependency ignores its signal and
 * never resolves. An unsettled dispatcher promise would otherwise pin the
 * supervisor's in-flight accounting indefinitely.
 */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
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
