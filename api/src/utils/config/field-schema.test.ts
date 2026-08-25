import { PUBLIC_ROLE_KEY } from '@cairncms/constants';
import { normalizeRoleKey } from '@cairncms/utils';
import Joi from 'joi';
import { describe, expect, it } from 'vitest';
import type { ConfigKind } from '../../types/config.js';
import {
	PERMISSION_COLLECTION_MAX_LENGTH,
	ROLE_ICON_MAX_LENGTH,
	ROLE_KEY_MAX_LENGTH,
	ROLE_NAME_MAX_LENGTH,
	SUPPORTED_ACTIONS,
} from '../config-contract.js';
import { replaceControlCharacters } from '../safe-log-fragment.js';
import type { ConfigFieldDescriptor } from './descriptor.js';
import { buildDocumentSchema, type DocumentSchemaSpec } from './field-schema.js';
import { permissionsDescriptor } from './handlers/permissions.js';
import { rolesDescriptor } from './handlers/roles.js';

const VALIDATE_OPTIONS = { convert: false, abortEarly: false } as const;

// Keep this oracle independent of descriptor metadata so schema-contract drift remains detectable.
const EXPECTED_ROLE_KEY_SCHEMA = Joi.string()
	.min(1)
	.max(ROLE_KEY_MAX_LENGTH)
	.custom((value, helpers) => (normalizeRoleKey(value) === value ? value : helpers.error('roleKey.grammar')))
	.messages({
		'roleKey.grammar':
			'{{#label}} must be lowercase alphanumeric with underscores, and cannot start with a digit or underscore.',
	});

const EXPECTED_ROLE_RECORD_KEY_SCHEMA = EXPECTED_ROLE_KEY_SCHEMA.invalid(PUBLIC_ROLE_KEY).messages({
	'any.invalid': '{{#label}} is reserved for public permissions and cannot name a role.',
});

const EXPECTED_POLICY_OBJECT_SCHEMA = Joi.object().unknown().allow(null);
const EXPECTED_STRING_LIST_SCHEMA = Joi.array().items(Joi.string().allow('')).allow(null);

const EXPECTED_ROLE_RECORD_SCHEMA = Joi.object({
	key: EXPECTED_ROLE_RECORD_KEY_SCHEMA.required(),
	name: Joi.string().allow('').max(ROLE_NAME_MAX_LENGTH).required(),
	admin_access: Joi.boolean().required(),
	app_access: Joi.boolean().required(),
	icon: Joi.string().allow('').max(ROLE_ICON_MAX_LENGTH),
	enforce_tfa: Joi.boolean(),
	description: Joi.string().allow('', null),
	ip_access: EXPECTED_STRING_LIST_SCHEMA,
});

const EXPECTED_PERMISSION_SCHEMA = Joi.object({
	collection: Joi.string().min(1).max(PERMISSION_COLLECTION_MAX_LENGTH).required(),
	action: Joi.string()
		.valid(...SUPPORTED_ACTIONS)
		.required(),
	permissions: EXPECTED_POLICY_OBJECT_SCHEMA.required(),
	validation: EXPECTED_POLICY_OBJECT_SCHEMA.required(),
	presets: EXPECTED_POLICY_OBJECT_SCHEMA.required(),
	fields: EXPECTED_STRING_LIST_SCHEMA.required(),
});

const EXPECTED_PERMISSION_SET_SCHEMA = Joi.object({
	role: EXPECTED_ROLE_KEY_SCHEMA.required(),
	permissions: Joi.array().items(EXPECTED_PERMISSION_SCHEMA).required(),
});

const generated = {
	roles: buildDocumentSchema(rolesDescriptor),
	permissions: buildDocumentSchema(permissionsDescriptor),
};

const expectedSchemas = {
	roles: EXPECTED_ROLE_RECORD_SCHEMA,
	permissions: EXPECTED_PERMISSION_SET_SCHEMA,
};

function messagesOf(schema: Joi.ObjectSchema, input: unknown): string[] {
	const { error } = schema.validate(input, VALIDATE_OPTIONS);
	return error ? error.details.map((detail) => replaceControlCharacters(detail.message)) : [];
}

function role(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { key: 'editor', name: 'Editor', admin_access: false, app_access: true, ...overrides };
}

function permission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		collection: 'articles',
		action: 'read',
		permissions: {},
		validation: null,
		presets: null,
		fields: ['id'],
		...overrides,
	};
}

function permissionSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { role: 'editor', permissions: [permission()], ...overrides };
}

type Case = { name: string; kind: ConfigKind; input: unknown; valid: boolean };

const CASES: Case[] = [
	{
		name: 'full valid role',
		kind: 'roles',
		input: role({ icon: 'star', enforce_tfa: true, description: 'd', ip_access: ['1.2.3.4'] }),
		valid: true,
	},
	{ name: 'minimal valid role', kind: 'roles', input: role(), valid: true },
	{ name: 'role with empty name', kind: 'roles', input: role({ name: '' }), valid: true },
	{ name: 'role with null description', kind: 'roles', input: role({ description: null }), valid: true },
	{ name: 'role with null ip_access', kind: 'roles', input: role({ ip_access: null }), valid: true },
	{
		name: 'role with empty-string ip_access element',
		kind: 'roles',
		input: role({ ip_access: ['', '1.2.3.4'] }),
		valid: true,
	},
	{ name: 'role reserved public key', kind: 'roles', input: role({ key: 'public' }), valid: false },
	{ name: 'role bad-grammar key', kind: 'roles', input: role({ key: 'Editor' }), valid: false },
	{
		name: 'role missing admin_access',
		kind: 'roles',
		input: { key: 'editor', name: 'X', app_access: true },
		valid: false,
	},
	{ name: 'role unknown field', kind: 'roles', input: role({ extra: 1 }), valid: false },
	{ name: 'role name too long', kind: 'roles', input: role({ name: 'x'.repeat(101) }), valid: false },
	{ name: 'role non-boolean admin_access', kind: 'roles', input: role({ admin_access: 'false' }), valid: false },
	{ name: 'role null name', kind: 'roles', input: role({ name: null }), valid: false },

	{ name: 'valid permission set', kind: 'permissions', input: permissionSet(), valid: true },
	{ name: 'empty permission set', kind: 'permissions', input: permissionSet({ permissions: [] }), valid: true },
	{
		name: 'public permission-set subject',
		kind: 'permissions',
		input: permissionSet({ role: 'public', permissions: [] }),
		valid: true,
	},
	{
		name: 'permission null fields',
		kind: 'permissions',
		input: permissionSet({ permissions: [permission({ fields: null })] }),
		valid: true,
	},
	{
		name: 'permission bad action',
		kind: 'permissions',
		input: permissionSet({ permissions: [permission({ action: 'frobnicate' })] }),
		valid: false,
	},
	{
		name: 'permission missing validation',
		kind: 'permissions',
		input: permissionSet({
			permissions: [{ collection: 'a', action: 'read', permissions: null, presets: null, fields: null }],
		}),
		valid: false,
	},
	{
		name: 'permission empty collection',
		kind: 'permissions',
		input: permissionSet({ permissions: [permission({ collection: '' })] }),
		valid: false,
	},
	{
		name: 'permission unknown field',
		kind: 'permissions',
		input: permissionSet({ permissions: [permission({ extra: 1 })] }),
		valid: false,
	},
	{
		name: 'permission non-object policy',
		kind: 'permissions',
		input: permissionSet({ permissions: [permission({ permissions: 'nope' })] }),
		valid: false,
	},
	{
		name: 'permission bad-grammar subject',
		kind: 'permissions',
		input: permissionSet({ role: 'Editor' }),
		valid: false,
	},
	{ name: 'permission set missing permissions array', kind: 'permissions', input: { role: 'editor' }, valid: false },
];

describe('generated config document schema', () => {
	it.each(CASES)('$name matches the established schema contract', ({ kind, input, valid }) => {
		const generatedErrors = messagesOf(generated[kind], input);

		expect(generatedErrors).toEqual(messagesOf(expectedSchemas[kind], input));
		expect(generatedErrors.length === 0).toBe(valid);
	});
});

describe('generator honors metadata for field-type/nullable combinations the production fields do not exercise', () => {
	const base: Omit<ConfigFieldDescriptor, 'name' | 'type'> = {
		required: false,
		nullable: true,
		acceptsPlaceholder: false,
		sensitivity: { secret: false, redact: 'none' },
		snapshotSafe: true,
		mutable: true,
		omissionPreservesCurrent: false,
	};

	function syntheticSchema(recordFields: ConfigFieldDescriptor[]): Joi.ObjectSchema {
		const spec: DocumentSchemaSpec = { layout: { documentShape: 'flat' }, documentIdentityFields: [], recordFields };
		return buildDocumentSchema(spec);
	}

	it('applies nullable to a boolean', () => {
		const schema = syntheticSchema([{ ...base, name: 'flag', type: 'boolean', nullable: true }]);
		expect(messagesOf(schema, { flag: null })).toEqual([]);
	});

	it('rejects null on a non-nullable boolean', () => {
		const schema = syntheticSchema([{ ...base, name: 'flag', type: 'boolean', nullable: false }]);
		expect(messagesOf(schema, { flag: null }).length).toBeGreaterThan(0);
	});

	it('applies nullable to an enum', () => {
		const schema = syntheticSchema([{ ...base, name: 'choice', type: 'string', nullable: true, enum: ['a', 'b'] }]);
		expect(messagesOf(schema, { choice: null })).toEqual([]);
		expect(messagesOf(schema, { choice: 'c' }).length).toBeGreaterThan(0);
	});

	it('applies nullable to a role-key grammar field', () => {
		const schema = syntheticSchema([
			{ ...base, name: 'rk', type: 'string', nullable: true, grammar: 'role-key', minLength: 1, maxLength: 10 },
		]);

		expect(messagesOf(schema, { rk: null })).toEqual([]);
		expect(messagesOf(schema, { rk: 'Bad' }).length).toBeGreaterThan(0);
	});
});
