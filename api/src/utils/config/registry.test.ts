import { describe, expect, it } from 'vitest';
import { CONFIG_KINDS, type ConfigPermission, type ConfigRole } from '../../types/config.js';
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

describe('descriptor canonicalizeValues', () => {
	it('resolves omitted role optionals to their defaults and drops the key', () => {
		const role: ConfigRole = { key: 'editor', name: 'Editor', admin_access: false, app_access: true };

		expect(getDescriptor('roles').canonicalizeValues(role)).toEqual({
			name: 'Editor',
			icon: 'supervised_user_circle',
			description: null,
			admin_access: false,
			app_access: true,
			enforce_tfa: false,
			ip_access: null,
		});
	});

	it('preserves provided role optionals', () => {
		const role: ConfigRole = {
			key: 'editor',
			name: 'Editor',
			icon: 'edit',
			description: 'desc',
			admin_access: true,
			app_access: true,
			enforce_tfa: true,
			ip_access: ['10.0.0.0/8'],
		};

		expect(getDescriptor('roles').canonicalizeValues(role)).toEqual({
			name: 'Editor',
			icon: 'edit',
			description: 'desc',
			admin_access: true,
			app_access: true,
			enforce_tfa: true,
			ip_access: ['10.0.0.0/8'],
		});
	});

	it('sorts role ip_access without mutating the input', () => {
		const ip_access = ['10.0.0.2', '10.0.0.1'];
		const role: ConfigRole = { key: 'editor', name: 'Editor', admin_access: false, app_access: true, ip_access };

		expect(getDescriptor('roles').canonicalizeValues(role).ip_access).toEqual(['10.0.0.1', '10.0.0.2']);
		expect(ip_access).toEqual(['10.0.0.2', '10.0.0.1']);
	});

	it('carries the permission value fields and drops identity', () => {
		const permission: ConfigPermission = {
			collection: 'articles',
			action: 'read',
			permissions: { _and: [] },
			validation: null,
			presets: { status: 'draft' },
			fields: ['title'],
		};

		const record = { role: 'editor', ...permission };

		expect(getDescriptor('permissions').canonicalizeValues(record)).toEqual({
			permissions: { _and: [] },
			validation: null,
			presets: { status: 'draft' },
			fields: ['title'],
		});
	});

	it('sorts permission fields without mutating the input', () => {
		const fields = ['title', 'body'];

		const permission: ConfigPermission = {
			collection: 'articles',
			action: 'read',
			permissions: null,
			validation: null,
			presets: null,
			fields,
		};

		const record = { role: 'editor', ...permission };

		expect(getDescriptor('permissions').canonicalizeValues(record).fields).toEqual(['body', 'title']);
		expect(fields).toEqual(['title', 'body']);
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
