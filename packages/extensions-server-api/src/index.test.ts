import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type {
	ExtensionFieldDelivery,
	ExtensionResult,
	ExtensionSecretReference,
	ExtensionSettingsClient,
} from './index.js';
import * as serverApi from './index.js';
import { defineEventHook, defineFlowOperation, defineJsonEndpoint } from './index.js';
import type { JsonEndpointRequest } from './index.js';

const source = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf-8');

describe('extensions-server-api define helpers', () => {
	it('returns the same object identity it was given', () => {
		const config = { id: 'x', handler: () => undefined } as any;

		expect(defineFlowOperation(config)).toBe(config);
		expect(defineJsonEndpoint(config)).toBe(config);
		expect(defineEventHook({ id: 'x', filters: {} })).toEqual({ id: 'x', filters: {} });
	});

	it('exposes only the portable identity helpers as runtime exports', () => {
		expect(Object.keys(serverApi).sort()).toEqual(['defineEventHook', 'defineFlowOperation', 'defineJsonEndpoint']);
	});

	it('admits every JSON endpoint method including HEAD and OPTIONS', () => {
		const methods: JsonEndpointRequest['method'][] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

		expect(methods).toHaveLength(7);
	});

	it('models host denials as a structured result rather than a thrown error', () => {
		const ok: ExtensionResult<number> = { ok: true, value: 1 };
		const denied: ExtensionResult<number> = { ok: false, error: { code: 'denied', message: 'not permitted' } };

		expect(ok.ok && ok.value).toBe(1);
		expect(!denied.ok && denied.error.code).toBe('denied');
	});

	it('models a secret reference as a serializable handle distinct from the internal placeholder', () => {
		const reference: ExtensionSecretReference = { kind: 'secret-reference', ref: 'opaque-handle' };
		const delivery: ExtensionFieldDelivery = 'reference';

		expect(reference.kind).toBe('secret-reference');
		expect(reference).not.toHaveProperty('$secret');
		expect(JSON.parse(JSON.stringify(reference))).toEqual(reference);
		expect(['raw', 'reference', 'brokered']).toContain(delivery);
	});

	it('lets settings.get resolve a sensitive value to a secret reference or a plain value', () => {
		type SettingsResult = Awaited<ReturnType<ExtensionSettingsClient['get']>>;

		const sensitive: SettingsResult = { ok: true, value: { kind: 'secret-reference', ref: 'opaque-handle' } };
		const plain: SettingsResult = { ok: true, value: 'plain' };
		const absent: SettingsResult = { ok: true, value: null };

		expect(sensitive.ok && (sensitive.value as ExtensionSecretReference).kind).toBe('secret-reference');
		expect(plain.ok && plain.value).toBe('plain');
		expect(absent.ok && absent.value).toBeNull();
	});
});

describe('extensions-server-api portable boundary', () => {
	it('imports nothing in source', () => {
		expect(source).not.toMatch(/\bfrom\s+['"]/);
	});

	it('references no raw authority or node builtins', () => {
		const forbidden = ['node:', 'knex', 'express', 'pino', 'process.env', '@cairncms/api', '@cairncms/utils'];

		for (const token of forbidden) {
			expect(source.includes(token), `source must not reference ${token}`).toBe(false);
		}
	});
});
