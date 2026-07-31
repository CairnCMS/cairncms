import { PUBLIC_ROLE_KEY } from '@cairncms/constants';
import { normalizeRoleKey } from '@cairncms/utils';
import Joi from 'joi';
import { isPlainObject } from 'lodash-es';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigUnsupportedVersionException } from '../exceptions/config-unsupported-version.js';
import { CONFIG_KINDS, type ConfigKind, type ConfigManifest } from '../types/config.js';
import {
	PERMISSION_COLLECTION_MAX_LENGTH,
	ROLE_ICON_MAX_LENGTH,
	ROLE_KEY_MAX_LENGTH,
	ROLE_NAME_MAX_LENGTH,
	SUPPORTED_ACTIONS,
	SUPPORTED_MANIFEST_VERSION,
} from './config-contract.js';
import { replaceControlCharacters, safeLogFragment } from './safe-log-fragment.js';

/** Callers keep the input object, so coercing "false" would validate while the planner sees a truthy string. */
const VALIDATE_OPTIONS = { convert: false, abortEarly: false } as const;

const ROLE_KEY_GRAMMAR = Joi.string()
	.min(1)
	.max(ROLE_KEY_MAX_LENGTH)
	.custom((value, helpers) => (normalizeRoleKey(value) === value ? value : helpers.error('roleKey.grammar')))
	.messages({
		'roleKey.grammar':
			'{{#label}} must be lowercase alphanumeric with underscores, and cannot start with a digit or underscore.',
	});

const ROLE_RECORD_KEY = ROLE_KEY_GRAMMAR.invalid(PUBLIC_ROLE_KEY).messages({
	'any.invalid': '{{#label}} is reserved for public permissions and cannot name a role.',
});

/** Operator-authored field names and filter operators live inside, so only the container is checked. */
const POLICY_OBJECT = Joi.object().unknown().allow(null);

const STRING_LIST = Joi.array().items(Joi.string().allow('')).allow(null);

const ROLE_RECORD = Joi.object({
	key: ROLE_RECORD_KEY.required(),
	name: Joi.string().allow('').max(ROLE_NAME_MAX_LENGTH).required(),
	admin_access: Joi.boolean().required(),
	app_access: Joi.boolean().required(),
	icon: Joi.string().allow('').max(ROLE_ICON_MAX_LENGTH),
	enforce_tfa: Joi.boolean(),
	description: Joi.string().allow('', null),
	ip_access: STRING_LIST,
});

const PERMISSION = Joi.object({
	collection: Joi.string().min(1).max(PERMISSION_COLLECTION_MAX_LENGTH).required(),
	action: Joi.string()
		.valid(...SUPPORTED_ACTIONS)
		.required(),
	permissions: POLICY_OBJECT.required(),
	validation: POLICY_OBJECT.required(),
	presets: POLICY_OBJECT.required(),
	fields: STRING_LIST.required(),
});

const PERMISSION_SET_RECORD = Joi.object({
	role: ROLE_KEY_GRAMMAR.required(),
	permissions: Joi.array().items(PERMISSION).required(),
});

const RECORD_SCHEMA: Record<ConfigKind, Joi.ObjectSchema> = {
	roles: ROLE_RECORD,
	permissions: PERMISSION_SET_RECORD,
};

const MANIFEST = Joi.object({
	version: Joi.valid(SUPPORTED_MANIFEST_VERSION).required(),
	resources: Joi.array()
		.items(Joi.string().valid(...CONFIG_KINDS))
		.unique()
		.required(),
});

function messagesOf(error: Joi.ValidationError | undefined): string[] {
	if (!error) return [];
	return error.details.map((detail) => replaceControlCharacters(detail.message));
}

/** Unsupported versions keep their dedicated error code. */
export function validateConfigManifest(value: unknown, label: string): ConfigManifest {
	const where = safeLogFragment(label);

	if (!isPlainObject(value)) {
		throw new ConfigInvalidException(`Config manifest in ${where} must be a mapping.`);
	}

	const declared = value as Record<string, unknown>;

	if (declared['version'] !== SUPPORTED_MANIFEST_VERSION) {
		throw new ConfigUnsupportedVersionException(
			`Config manifest in ${where} declares version ${
				declared['version'] === undefined ? 'none' : safeLogFragment(declared['version'])
			}. This engine supports version ${SUPPORTED_MANIFEST_VERSION}.`
		);
	}

	const { error } = MANIFEST.validate(declared, VALIDATE_OPTIONS);

	if (error) {
		throw new ConfigInvalidException(`Config manifest in ${where} is invalid: ${messagesOf(error).join('; ')}`);
	}

	return declared as unknown as ConfigManifest;
}

export function validateConfigRecord(kind: ConfigKind, record: unknown): string[] {
	return messagesOf(RECORD_SCHEMA[kind].validate(record, VALIDATE_OPTIONS).error);
}

export type DesiredConfigContext = {
	label: string;
	currentRoleKeys: ReadonlySet<string>;
};

function envelopeSchema(managed: ReadonlySet<ConfigKind>): Joi.ObjectSchema {
	const kinds = Object.fromEntries(
		CONFIG_KINDS.map((kind) => [
			kind,
			managed.has(kind) ? Joi.array().items(RECORD_SCHEMA[kind]).required() : Joi.array().required(),
		])
	);

	return Joi.object({ manifest: Joi.any(), ...kinds });
}

export function validateDesiredConfig(document: unknown, context: DesiredConfigContext): string[] {
	if (!isPlainObject(document)) {
		throw new ConfigInvalidException(`Config document in ${safeLogFragment(context.label)} must be a mapping.`);
	}

	const body = document as Record<string, unknown>;
	const manifest = validateConfigManifest(body['manifest'], context.label);
	const managed = new Set<ConfigKind>(manifest.resources);

	const fieldErrors = messagesOf(envelopeSchema(managed).validate(body, VALIDATE_OPTIONS).error);
	if (fieldErrors.length > 0) return fieldErrors;

	const declaredRoleKeys = new Set<string>();
	const errors: string[] = [];

	if (managed.has('roles')) {
		for (const role of body['roles'] as Array<{ key: string }>) {
			if (declaredRoleKeys.has(role.key)) {
				errors.push(`Duplicate role "${safeLogFragment(role.key)}".`);
			}

			declaredRoleKeys.add(role.key);
		}
	}

	if (managed.has('permissions')) {
		errors.push(...permissionErrors(body['permissions'] as PermissionSetShape[], managed, declaredRoleKeys, context));
	}

	return errors;
}

type PermissionSetShape = { role: string; permissions: Array<{ collection: string; action: string }> };

function permissionErrors(
	sets: PermissionSetShape[],
	managed: ReadonlySet<ConfigKind>,
	declaredRoleKeys: ReadonlySet<string>,
	context: DesiredConfigContext
): string[] {
	const errors: string[] = [];
	const subjects = new Set<string>();

	for (const set of sets) {
		const subject = safeLogFragment(set.role);

		if (subjects.has(set.role)) {
			errors.push(`Duplicate permission set for role "${subject}".`);
		}

		subjects.add(set.role);

		if (set.role !== PUBLIC_ROLE_KEY) {
			if (managed.has('roles')) {
				if (!declaredRoleKeys.has(set.role)) {
					errors.push(`Permission set references role "${subject}", which no role file declares.`);
				}
			} else if (!context.currentRoleKeys.has(set.role)) {
				errors.push(`Permission set references role "${subject}", which does not exist in the database.`);
			}
		}

		const tuples = new Set<string>();

		for (const permission of set.permissions) {
			const tuple = `${permission.collection}:${permission.action}`;

			if (tuples.has(tuple)) {
				errors.push(
					`Duplicate permission for role "${subject}": collection "${safeLogFragment(
						permission.collection
					)}", action "${safeLogFragment(permission.action)}".`
				);
			}

			tuples.add(tuple);
		}
	}

	return errors;
}
