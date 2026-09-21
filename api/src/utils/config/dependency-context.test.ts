import { describe, expect, it } from 'vitest';
import type { ConfigKind } from '../../types/config.js';
import { makeDependencyAccessor } from './dependency-context.js';

type BothKinds = Record<ConfigKind, unknown>;

function accessor(declared: ConfigKind[], published: Array<[ConfigKind, unknown]>) {
	return makeDependencyAccessor<BothKinds>(declared, new Map(published));
}

describe('makeDependencyAccessor', () => {
	it('throws for an undeclared dependency', () => {
		expect(() => accessor(['roles'], [['roles', { a: 1 }]])('permissions')).toThrow(
			/undeclared dependency "permissions"/
		);
	});

	it('throws for a declared dependency that was not published', () => {
		expect(() => accessor(['roles'], [])('roles')).toThrow(/"roles" was not published/);
	});

	it('returns the published state for a declared, published dependency', () => {
		expect(accessor(['roles'], [['roles', { roleIdByKey: 'x' }]])('roles')).toEqual({ roleIdByKey: 'x' });
	});

	it('treats a published undefined as a value, not a missing dependency', () => {
		const read = accessor(['permissions'], [['permissions', undefined]]);
		expect(read('permissions')).toBeUndefined();
	});
});
