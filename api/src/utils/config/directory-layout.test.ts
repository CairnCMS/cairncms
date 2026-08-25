import { describe, expect, it } from 'vitest';
import { ConfigReadFailedException } from '../../exceptions/config-read-failed.js';
import type { ConfigFieldDescriptor } from './descriptor.js';
import {
	classifyConfigFilename,
	classifyIdentityStem,
	isOwnedConfigFilename,
	normalizeStringListFields,
} from './directory-layout.js';
import { getDescriptor, listConfigKinds } from './registry.js';

function identityField(overrides: Partial<ConfigFieldDescriptor>): ConfigFieldDescriptor {
	return {
		name: 'key',
		type: 'string',
		required: true,
		nullable: false,
		acceptsPlaceholder: false,
		sensitivity: { secret: false, redact: 'none' },
		snapshotSafe: true,
		mutable: false,
		omissionPreservesCurrent: false,
		...overrides,
	};
}

describe('classifyConfigFilename', () => {
	it('reserves a stem the kind reserves and owns it where the kind does not', () => {
		expect(classifyConfigFilename('public.yaml', 'roles')).toBe('reserved');
		expect(classifyConfigFilename('public.yaml', 'permissions')).toBe('owned');
	});

	it('owns a generated name for each kind', () => {
		expect(classifyConfigFilename('content_reviewer.yaml', 'roles')).toBe('owned');
		expect(classifyConfigFilename('editor.yaml', 'permissions')).toBe('owned');
	});

	it('treats anything else as unowned', () => {
		expect(classifyConfigFilename('README.md', 'roles')).toBe('unowned');
		expect(classifyConfigFilename('editor.yml', 'roles')).toBe('unowned');
		expect(classifyConfigFilename('.yaml', 'roles')).toBe('unowned');
		expect(classifyConfigFilename('Editor.yaml', 'roles')).toBe('unowned');
		expect(classifyConfigFilename('editor.backup.yaml', 'roles')).toBe('unowned');
		expect(classifyConfigFilename(`${'a'.repeat(256)}.yaml`, 'roles')).toBe('unowned');
	});
});

describe('isOwnedConfigFilename', () => {
	it('accepts a name the record set would have generated', () => {
		expect(isOwnedConfigFilename('content_reviewer.yaml', 'roles')).toBe(true);
		expect(isOwnedConfigFilename('editor.yaml', 'permissions')).toBe(true);
	});

	it('rejects a stem the platform would have stored under a different key', () => {
		expect(isOwnedConfigFilename('2fa_admin.yaml', 'roles')).toBe(false);
		expect(isOwnedConfigFilename('_tmp.yaml', 'roles')).toBe(false);
		expect(isOwnedConfigFilename('.yaml', 'roles')).toBe(false);
		expect(isOwnedConfigFilename('Editor.yaml', 'roles')).toBe(false);
		expect(isOwnedConfigFilename('editor.backup.yaml', 'roles')).toBe(false);
		expect(isOwnedConfigFilename(`edi${String.fromCharCode(1)}tor.yaml`, 'roles')).toBe(false);
		expect(isOwnedConfigFilename(`${'a'.repeat(256)}.yaml`, 'roles')).toBe(false);
	});

	it('treats the public permission subject as owned only where it can exist', () => {
		expect(isOwnedConfigFilename('public.yaml', 'permissions')).toBe(true);
		expect(isOwnedConfigFilename('public.yaml', 'roles')).toBe(false);
	});
});

describe('classifyIdentityStem', () => {
	it('reserves before grammar, so a reserved stem that fails the grammar is still reserved', () => {
		const field = identityField({ reserved: ['Bad Key'], grammar: 'role-key', maxLength: 255 });
		expect(classifyIdentityStem('Bad Key', field)).toBe('reserved');
	});

	it('never owns a stem when ownership metadata is absent', () => {
		expect(classifyIdentityStem('editor', identityField({ grammar: 'role-key' }))).toBe('unowned');
		expect(classifyIdentityStem('editor', identityField({ maxLength: 255 }))).toBe('unowned');
		expect(classifyIdentityStem('editor', identityField({ grammar: 'role-key', maxLength: 0 }))).toBe('unowned');
	});

	it('owns a valid stem when the field declares grammar and a bounded length', () => {
		expect(classifyIdentityStem('editor', identityField({ grammar: 'role-key', maxLength: 255 }))).toBe('owned');
	});
});

describe('descriptor directory conformance', () => {
	it('each kind has a single string identity field with ownership grammar and a bounded length', () => {
		for (const kind of listConfigKinds()) {
			const descriptor = getDescriptor(kind);
			expect(descriptor.documentIdentityFields).toHaveLength(1);

			const field = descriptor.documentIdentityFields[0]!;
			expect(field.type).toBe('string');
			expect(field.grammar).toBe('role-key');
			expect(typeof field.maxLength).toBe('number');
			expect(field.maxLength).toBeGreaterThan(0);

			if (field.reserved && field.reserved.length > 0) {
				expect(typeof descriptor.layout.reservedFilenameMessage).toBe('function');
			}

			for (const recordField of descriptor.recordFields) {
				if (recordField.type === 'string-list') {
					expect(typeof recordField.canonicalize).toBe('function');
				}
			}
		}
	});

	it('the roles filename identity agrees with its layout', () => {
		const descriptor = getDescriptor('roles');
		const document = { key: 'editor', name: 'Editor', admin_access: false, app_access: true };
		expect(descriptor.layout.filenameOf(descriptor.layout.documentIdentityOf(document))).toBe(document.key);
	});

	it('the permissions filename identity agrees with its layout', () => {
		const descriptor = getDescriptor('permissions');
		const document = { role: 'editor', permissions: [] };
		expect(descriptor.layout.filenameOf(descriptor.layout.documentIdentityOf(document))).toBe(document.role);
	});
});

describe('normalizeStringListFields', () => {
	const fields = getDescriptor('roles').recordFields;

	it('sorts an own-present string-list field', () => {
		expect(normalizeStringListFields(fields, { key: 'a', ip_access: ['10.0.0.2', '10.0.0.1'] })).toEqual({
			key: 'a',
			ip_access: ['10.0.0.1', '10.0.0.2'],
		});
	});

	it('leaves an omitted string-list field absent and a null one null', () => {
		expect(normalizeStringListFields(fields, { key: 'a' })).toEqual({ key: 'a' });
		expect(normalizeStringListFields(fields, { key: 'a', ip_access: null })).toEqual({ key: 'a', ip_access: null });
	});

	it('does not mutate its input', () => {
		const input = { key: 'a', ip_access: ['10.0.0.2', '10.0.0.1'] };
		normalizeStringListFields(fields, input);
		expect(input.ip_access).toEqual(['10.0.0.2', '10.0.0.1']);
	});

	it('fails operationally when a string-list field carries no canonicalizer', () => {
		const badFields: ConfigFieldDescriptor[] = [identityField({ name: 'tags', type: 'string-list' })];
		expect(() => normalizeStringListFields(badFields, { tags: ['b', 'a'] })).toThrow(ConfigReadFailedException);
	});
});
