import { describe, expect, it } from 'vitest';
import { CONFIG_KINDS, type ConfigPermission, type ConfigRole } from '../../types/config.js';
import type { ConfigFieldDescriptor } from './descriptor.js';
import {
	CONFIG_REGISTRY,
	descriptorAtVersion,
	documentAtVersion,
	fieldsAboveVersion,
	forKind,
	getDescriptor,
	kindsForVersion,
	listConfigKinds,
} from './registry.js';

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

describe('kindsForVersion gate', () => {
	it('admits roles and permissions at version 1', () => {
		expect(kindsForVersion(1).sort()).toEqual(['permissions', 'roles']);
	});

	it('adds the version 2 kinds without schema', () => {
		expect(kindsForVersion(2)).not.toContain('schema');

		expect(kindsForVersion(2).sort()).toEqual(
			['extension-settings', 'folders', 'permissions', 'roles', 'settings', 'translations'].sort()
		);
	});

	it('admits schema only at version 3', () => {
		expect(kindsForVersion(1)).not.toContain('schema');
		expect(kindsForVersion(2)).not.toContain('schema');
		expect(kindsForVersion(3)).toContain('schema');
		expect(kindsForVersion(3).sort()).toEqual([...CONFIG_KINDS].sort());
	});

	it('admits the same kinds at version 4 as at version 3', () => {
		expect(kindsForVersion(4)).toEqual(kindsForVersion(3));
	});
});

describe('field manifest versions', () => {
	const plain: ConfigFieldDescriptor = { ...getDescriptor('settings').recordFields[0]!, name: 'plain_field' };
	const gated: ConfigFieldDescriptor = { ...plain, name: 'gated_field', formatVersion: 4 };
	const unversioned = { formatVersion: 2, recordFields: [plain], valueFieldOrder: ['plain_field'] };

	const versioned = {
		formatVersion: 2,
		recordFields: [plain, gated],
		valueFieldOrder: ['plain_field', 'gated_field'],
	};

	it('places a field without its own version at its kind version', () => {
		expect(fieldsAboveVersion(unversioned, 2)).toEqual([]);
		expect(fieldsAboveVersion({ ...unversioned, formatVersion: 3 }, 2)).toEqual([plain]);
	});

	it('excludes a field below its own version and admits it from that version', () => {
		expect(fieldsAboveVersion(versioned, 3)).toEqual([gated]);
		expect(fieldsAboveVersion(versioned, 4)).toEqual([]);
	});

	it('restricts the record fields and value order, leaving the source descriptor unchanged', () => {
		const atThree = descriptorAtVersion(versioned, 3);

		expect(atThree.recordFields).toEqual([plain]);
		expect(atThree.valueFieldOrder).toEqual(['plain_field']);
		expect(versioned.recordFields).toEqual([plain, gated]);
		expect(versioned.valueFieldOrder).toEqual(['plain_field', 'gated_field']);
		expect(descriptorAtVersion(versioned, 4)).toBe(versioned);
		expect(descriptorAtVersion(unversioned, 2)).toBe(unversioned);
	});

	it('introduces storage_asset_public_transforms at version 4 as the only settings field above version 3', () => {
		const settings = getDescriptor('settings');

		expect(fieldsAboveVersion(settings, 3).map((field) => field.name)).toEqual(['storage_asset_public_transforms']);
		expect(fieldsAboveVersion(settings, 4)).toEqual([]);
	});

	it('removes excluded fields from a copy of the document without mutating the original', () => {
		const document = { project_name: 'Source', gated_field: 'kept' };
		const atThree = documentAtVersion(versioned, document, 3);

		expect(atThree).toEqual({ project_name: 'Source' });
		expect(atThree).not.toBe(document);
		expect(document).toEqual({ project_name: 'Source', gated_field: 'kept' });
		expect(documentAtVersion(versioned, document, 4)).toBe(document);
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
