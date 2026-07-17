import type { Request } from 'express';
import { isPlainObject } from 'lodash-es';
import { collectSensitiveValuesExhaustive } from './redact-sensitive.js';

function collectScalarLeaves(value: unknown, out: Set<string>, seen: WeakSet<object>): void {
	if (typeof value === 'string') {
		if (value.trim().length > 0) out.add(value);
		return;
	}

	if (typeof value === 'number') {
		if (Number.isFinite(value)) out.add(String(value));
		return;
	}

	if (value === null || typeof value !== 'object' || seen.has(value)) return;
	seen.add(value);

	if (Array.isArray(value)) {
		for (const item of value) collectScalarLeaves(item, out, seen);
	} else if (isPlainObject(value)) {
		for (const item of Object.values(value)) collectScalarLeaves(item, out, seen);
	}
}

/**
 * The sensitive values reachable from a request: the bare bearer token, every cookie value's
 * scalar leaves, and values under recognized sensitive keys in the headers, query, and body.
 */
export function collectRequestSecrets(req: Request): Set<string> {
	const secrets = new Set<string>();

	if (typeof req.token === 'string' && req.token.trim().length > 0) {
		secrets.add(req.token);
	}

	const cookies = (req as { cookies?: unknown }).cookies;

	if (isPlainObject(cookies)) {
		const seen = new WeakSet<object>();
		for (const value of Object.values(cookies as Record<string, unknown>)) collectScalarLeaves(value, secrets, seen);
	}

	for (const source of [req.headers, req.query, (req as { body?: unknown }).body]) {
		for (const value of collectSensitiveValuesExhaustive(source)) secrets.add(value);
	}

	return secrets;
}
