import { describe, expect, it } from 'vitest';
import { CONFIG_KINDS, type ConfigPermission, type ConfigRole } from '../../types/config.js';
import { canonicalizePermission, canonicalizeRole } from '../canonicalize-config-record.js';
import { CONFIG_REGISTRY, forKind, getDescriptor, listConfigKinds } from './registry.js';

describe('config registry', () => {
	it('covers exactly CONFIG_KINDS', () => {
		expect(Object.keys(CONFIG_REGISTRY).sort()).toEqual([...CONFIG_KINDS].sort());
		expect(listConfigKinds().sort()).toEqual([...CONFIG_KINDS].sort());
	});

	it('each descriptor declares its own kind', () => {
		for (const kind of CONFIG_KINDS) {
			expect(getDescriptor(kind).kind).toBe(kind);
		}
	});

	it('forKind resolves the descriptor for its kind', () => {
		expect(forKind('roles', (descriptor) => descriptor.kind)).toBe('roles');
		expect(forKind('permissions', (descriptor) => descriptor.kind)).toBe('permissions');
	});
});

describe('descriptor canonicalization matches the current canonicalizers', () => {
	const roles: ConfigRole[] = [
		{ key: 'a', name: 'A', admin_access: true, app_access: true },
		{
			key: 'b',
			name: '',
			admin_access: false,
			app_access: false,
			icon: 'star',
			enforce_tfa: true,
			description: 'd',
			ip_access: ['9.9.9.9', '1.1.1.1'],
		},
		{ key: 'c', name: 'C', admin_access: false, app_access: true, description: null, ip_access: null },
	];

	it.each(roles)('role $key', (role) => {
		expect(getDescriptor('roles').canonicalizeValues(role)).toEqual(canonicalizeRole(role));
	});

	const permissions: ConfigPermission[] = [
		{ collection: 'a', action: 'read', permissions: {}, validation: null, presets: null, fields: ['b', 'a'] },
		{ collection: 'x', action: 'create', permissions: { _and: [] }, validation: {}, presets: { p: 1 }, fields: null },
	];

	it.each(permissions)('permission $collection/$action', (permission) => {
		const record = { role: 'editor', ...permission };
		expect(getDescriptor('permissions').canonicalizeValues(record)).toEqual(canonicalizePermission(permission));
	});
});

describe('document composition round-trips, preserving empty groups', () => {
	it('roles project and compose to the same documents', () => {
		const documents: ConfigRole[] = [
			{ key: 'a', name: 'A', admin_access: true, app_access: true },
			{ key: 'b', name: 'B', admin_access: false, app_access: true },
		];

		const { records, anchors } = getDescriptor('roles').projectDocuments(documents);
		expect(getDescriptor('roles').composeDocuments(records, anchors)).toEqual(documents);
	});

	it('permissions preserve an empty set through the round-trip', () => {
		const documents = [
			{
				role: 'a',
				permissions: [
					{
						collection: 'x',
						action: 'read',
						permissions: null,
						validation: null,
						presets: null,
						fields: null,
					} as ConfigPermission,
				],
			},
			{ role: 'b', permissions: [] as ConfigPermission[] },
		];

		const { records, anchors } = getDescriptor('permissions').projectDocuments(documents);
		expect(getDescriptor('permissions').composeDocuments(records, anchors)).toEqual(documents);
	});
});
