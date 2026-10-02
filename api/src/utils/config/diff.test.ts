import type { PermissionsAction } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import type { ConfigPermission, ConfigRole } from '../../types/config.js';
import type { ConfigFieldDescriptor, ConfigKindTypes } from './descriptor.js';
import { computeKindPlan, diffRecordValues, type RecordValueDiffInput } from './diff.js';
import { permissionsDescriptor } from './handlers/permissions.js';
import { rolesDescriptor } from './handlers/roles.js';
import { composeValues } from './values.js';

type PermissionRecord = ConfigPermission & { role: string };

function permission(
	overrides: Partial<PermissionRecord> & { role: string; collection: string; action: PermissionsAction }
): PermissionRecord {
	return { permissions: null, validation: null, presets: null, fields: null, ...overrides };
}

function field(overrides: Partial<ConfigFieldDescriptor> & { name: string }): ConfigFieldDescriptor {
	return {
		type: 'string',
		required: false,
		nullable: true,
		acceptsPlaceholder: false,
		sensitivity: { secret: false, redact: 'none' },
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
		...overrides,
	};
}

function spec(fields: ConfigFieldDescriptor[]): RecordValueDiffInput<ConfigKindTypes> {
	const order = fields.filter((f) => !f.identityComponent).map((f) => f.name);

	return {
		recordFields: fields,
		valueFieldOrder: order,
		canonicalizeValues: (record) => composeValues(fields, order, record as Record<string, unknown>),
	};
}

function keysOf(changes: unknown): string[] {
	return Object.keys(changes as Record<string, unknown>);
}

function role(overrides: Partial<ConfigRole> & { key: string }): ConfigRole {
	return { name: 'Role', admin_access: false, app_access: true, ...overrides };
}

describe('diffRecordValues field-contract behavior', () => {
	it('excludes a non-mutable field from the diff', () => {
		const changes = diffRecordValues(
			spec([field({ name: 'a' }), field({ name: 'b', mutable: false })]),
			{ a: '1', b: '1' },
			{ a: '2', b: '2' }
		);

		expect(keysOf(changes)).toEqual(['a']);
	});

	it('preserves current when an omissionPreservesCurrent field is omitted', () => {
		const preservingSpec = spec([
			field({ name: 'a', omissionPreservesCurrent: true, canonicalize: (v) => v ?? 'default' }),
		]);

		expect(keysOf(diffRecordValues(preservingSpec, { a: 'current' }, {}))).toEqual([]);
	});

	it('updates to the default when the same field is omitted but does not preserve current', () => {
		const defaultingSpec = spec([
			field({ name: 'a', omissionPreservesCurrent: false, canonicalize: (v) => v ?? 'default' }),
		]);

		expect(diffRecordValues(defaultingSpec, { a: 'current' }, {})).toEqual({
			a: { before: 'current', after: 'default' },
		});
	});

	it('emits no change when two inputs canonicalize equal', () => {
		const changes = diffRecordValues(
			rolesDescriptor,
			role({ key: 'a', ip_access: ['b', 'a'] }),
			role({ key: 'a', ip_access: ['a', 'b'] })
		);

		expect(changes).toEqual({});
	});

	it('emits changed fields in canonical order, not schema order', () => {
		const current = role({ key: 'a', name: 'A', admin_access: false, icon: 'x' });
		const desired = role({ key: 'a', name: 'B', admin_access: true, icon: 'y' });
		expect(keysOf(diffRecordValues(rolesDescriptor, current, desired))).toEqual(['name', 'icon', 'admin_access']);
	});
});

describe('identity key collision safety', () => {
	it('does not let a separator in one component forge another identity', () => {
		const a = permissionsDescriptor.identityKey({ role: 'a', collection: 'b::c', action: 'read' });
		const b = permissionsDescriptor.identityKey({ role: 'a::b', collection: 'c', action: 'read' });
		expect(a).not.toBe(b);
	});

	it('maps separately allocated equivalent identities to the same key', () => {
		const a = permissionsDescriptor.identityKey({ role: 'a', collection: 'b', action: 'read' });
		const b = permissionsDescriptor.identityKey({ role: 'a', collection: 'b', action: 'read' });
		expect(a).toBe(b);
	});
});

describe('computeKindPlan', () => {
	it('orders creates and updates by desired input, deletes by current state', () => {
		const current = [
			role({ key: 'keep_a', name: 'A' }),
			role({ key: 'keep_b', name: 'B' }),
			role({ key: 'del_x' }),
			role({ key: 'del_y' }),
		];

		const desired = [
			role({ key: 'new_1' }),
			role({ key: 'keep_b', name: 'B2' }),
			role({ key: 'new_2' }),
			role({ key: 'keep_a', name: 'A2' }),
		];

		const plan = computeKindPlan(rolesDescriptor, current, desired);

		expect(plan.create.map((r) => r.key)).toEqual(['new_1', 'new_2']);
		expect(plan.update.map((u) => u.key)).toEqual(['keep_b', 'keep_a']);
		expect(plan.delete).toEqual(['del_x', 'del_y']);
	});

	it('plans permission create, update, and delete, updating only the changed policy field', () => {
		const current = [
			permission({
				role: 'editor',
				collection: 'articles',
				action: 'read',
				permissions: { a: 1 },
				validation: { v: 1 },
			}),
			permission({ role: 'editor', collection: 'articles', action: 'update' }),
		];

		const desired = [
			permission({
				role: 'editor',
				collection: 'articles',
				action: 'read',
				permissions: { a: 2 },
				validation: { v: 1 },
			}),
			permission({ role: 'editor', collection: 'articles', action: 'create' }),
		];

		const plan = computeKindPlan(permissionsDescriptor, current, desired);

		expect(plan.create).toEqual([
			{
				roleKey: 'editor',
				permission: {
					collection: 'articles',
					action: 'create',
					permissions: null,
					validation: null,
					presets: null,
					fields: null,
				},
			},
		]);

		expect(plan.update).toEqual([
			{
				roleKey: 'editor',
				collection: 'articles',
				action: 'read',
				changes: { permissions: { before: { a: 1 }, after: { a: 2 } } },
			},
		]);

		expect(plan.delete).toEqual([{ roleKey: 'editor', collection: 'articles', action: 'update' }]);
	});
});

describe('descriptor value-field order', () => {
	it.each([rolesDescriptor, permissionsDescriptor])('is a permutation of $kind value fields', (descriptor) => {
		const valueFields = descriptor.recordFields.filter((f) => !f.identityComponent).map((f) => f.name);
		expect([...descriptor.valueFieldOrder].sort()).toEqual([...valueFields].sort());
	});
});
