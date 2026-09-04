import { describe, expect, it } from 'vitest';
import type { ConfigKind, ConfigManifest } from '../../types/config.js';
import { resolveReadClosure, resolveReconciliation } from './scope.js';

function manifest(resources: ConfigKind[]): ConfigManifest {
	return { version: 1, resources };
}

describe('resolveReadClosure', () => {
	it('reads nothing when no kinds are managed', () => {
		expect(resolveReadClosure(manifest([]))).toEqual([]);
	});

	it('reads a managed leaf kind fully', () => {
		expect(resolveReadClosure(manifest(['roles']))).toEqual([{ kind: 'roles', mode: 'full' }]);
	});

	it('reads an unmanaged dependency identity-only, before the dependent', () => {
		expect(resolveReadClosure(manifest(['permissions']))).toEqual([
			{ kind: 'roles', mode: 'identity' },
			{ kind: 'permissions', mode: 'full' },
		]);
	});

	it('reads both fully when both are managed and never downgrades', () => {
		expect(resolveReadClosure(manifest(['permissions', 'roles']))).toEqual([
			{ kind: 'roles', mode: 'full' },
			{ kind: 'permissions', mode: 'full' },
		]);
	});
});

describe('resolveReconciliation', () => {
	it('reconciles nothing when no kinds are managed', () => {
		expect(resolveReconciliation(manifest([]))).toEqual([]);
	});

	it('reconciles only managed kinds, in dependency order', () => {
		expect(resolveReconciliation(manifest(['permissions', 'roles']))).toEqual(['roles', 'permissions']);
	});

	it('does not reconcile an unmanaged dependency of a managed kind', () => {
		expect(resolveReconciliation(manifest(['permissions']))).toEqual(['permissions']);
	});
});
