import { describe, expect, it } from 'vitest';
import { computeConfigStateDigest, toStateDigestEntry, type StateDigestEntry } from './config-state-digest.js';

function fullRoles(values: Array<[string, unknown]>): StateDigestEntry {
	return { kind: 'roles', mode: 'full', identities: values.map(([key]) => key), values };
}

describe('computeConfigStateDigest', () => {
	it('returns a stable digest for the same entries', () => {
		const entries = [fullRoles([['["admin"]', { admin_access: true }]])];

		expect(computeConfigStateDigest(entries)).toBe(computeConfigStateDigest(entries));
	});

	it('changes when an identity is added or removed', () => {
		const base = computeConfigStateDigest([
			{ kind: 'roles', mode: 'identity', identities: ['["editor"]', '["viewer"]'] },
		]);

		const removed = computeConfigStateDigest([{ kind: 'roles', mode: 'identity', identities: ['["viewer"]'] }]);

		expect(removed).not.toBe(base);
	});

	it('changes when a value field changes', () => {
		const before = computeConfigStateDigest([fullRoles([['["admin"]', { admin_access: true }]])]);
		const after = computeConfigStateDigest([fullRoles([['["admin"]', { admin_access: false }]])]);

		expect(after).not.toBe(before);
	});

	it('is unaffected by value object key order', () => {
		const a = computeConfigStateDigest([fullRoles([['["admin"]', { admin_access: true, app_access: false }]])]);
		const b = computeConfigStateDigest([fullRoles([['["admin"]', { app_access: false, admin_access: true }]])]);

		expect(a).toBe(b);
	});

	it('distinguishes a full entry from an identity entry with the same identities', () => {
		const identity = computeConfigStateDigest([{ kind: 'roles', mode: 'identity', identities: ['["admin"]'] }]);
		const full = computeConfigStateDigest([fullRoles([['["admin"]', { admin_access: true }]])]);

		expect(full).not.toBe(identity);
	});
});

describe('toStateDigestEntry', () => {
	it('rejects a full projection that omits values', () => {
		expect(() => toStateDigestEntry('roles', 'full', { mode: 'full', identities: ['a'] } as never)).toThrow(
			/values in full mode/i
		);
	});

	it('rejects an identity projection that carries values', () => {
		expect(() =>
			toStateDigestEntry('roles', 'identity', { mode: 'identity', identities: ['a'], values: [] } as never)
		).toThrow(/values in identity mode/i);
	});

	it('rejects an identity projection with an own undefined values property', () => {
		expect(() =>
			toStateDigestEntry('roles', 'identity', { mode: 'identity', identities: ['a'], values: undefined } as never)
		).toThrow(/values in identity mode/i);
	});

	it('rejects a full projection with an own undefined values property', () => {
		expect(() =>
			toStateDigestEntry('roles', 'full', { mode: 'full', identities: ['a'], values: undefined } as never)
		).toThrow(/values in full mode/i);
	});

	it('rejects a projection whose reported mode does not match the read', () => {
		expect(() => toStateDigestEntry('roles', 'full', { mode: 'identity', identities: ['a'] } as never)).toThrow(
			/for a "full" read/i
		);
	});

	it('rejects non-array identities', () => {
		expect(() => toStateDigestEntry('roles', 'identity', { mode: 'identity', identities: 'nope' } as never)).toThrow(
			/non-array identities/i
		);
	});
});
