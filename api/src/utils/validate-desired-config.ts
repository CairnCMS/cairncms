import { PUBLIC_ROLE_KEY } from '@cairncms/constants';
import Joi from 'joi';
import { isPlainObject } from 'lodash-es';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigUnsupportedVersionException } from '../exceptions/config-unsupported-version.js';
import { CONFIG_KINDS, type ConfigFailure, type ConfigKind, type ConfigManifest } from '../types/config.js';
import { buildDocumentSchema } from './config/field-schema.js';
import { permissionsDescriptor } from './config/handlers/permissions.js';
import { rolesDescriptor } from './config/handlers/roles.js';
import { SUPPORTED_MANIFEST_VERSION } from './config-contract.js';
import { replaceControlCharacters, safeLogFragment } from './safe-log-fragment.js';

/** Callers keep the input object, so coercing "false" would validate while the planner sees a truthy string. */
const VALIDATE_OPTIONS = { convert: false, abortEarly: false } as const;

const RECORD_SCHEMA: Record<ConfigKind, Joi.ObjectSchema> = {
	roles: buildDocumentSchema(rolesDescriptor),
	permissions: buildDocumentSchema(permissionsDescriptor),
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

function invalid(message: string): ConfigFailure {
	return { code: 'CONFIG_INVALID', message };
}

function identityConflict(message: string): ConfigFailure {
	return { code: 'CONFIG_IDENTITY_CONFLICT', message };
}

export function validateDesiredConfig(document: unknown, context: DesiredConfigContext): ConfigFailure[] {
	if (!isPlainObject(document)) {
		throw new ConfigInvalidException(`Config document in ${safeLogFragment(context.label)} must be a mapping.`);
	}

	const body = document as Record<string, unknown>;
	const manifest = validateConfigManifest(body['manifest'], context.label);
	const managed = new Set<ConfigKind>(manifest.resources);

	const fieldErrors = messagesOf(envelopeSchema(managed).validate(body, VALIDATE_OPTIONS).error);
	if (fieldErrors.length > 0) return fieldErrors.map(invalid);

	const declaredRoleKeys = new Set<string>();
	const failures: ConfigFailure[] = [];

	if (managed.has('roles')) {
		for (const role of body['roles'] as Array<{ key: string }>) {
			if (declaredRoleKeys.has(role.key)) {
				failures.push(identityConflict(`Duplicate role "${safeLogFragment(role.key)}".`));
			}

			declaredRoleKeys.add(role.key);
		}
	}

	if (managed.has('permissions')) {
		failures.push(
			...permissionFailures(body['permissions'] as PermissionSetShape[], managed, declaredRoleKeys, context)
		);
	}

	return failures;
}

type PermissionSetShape = { role: string; permissions: Array<{ collection: string; action: string }> };

function permissionFailures(
	sets: PermissionSetShape[],
	managed: ReadonlySet<ConfigKind>,
	declaredRoleKeys: ReadonlySet<string>,
	context: DesiredConfigContext
): ConfigFailure[] {
	const failures: ConfigFailure[] = [];
	const subjects = new Set<string>();

	for (const set of sets) {
		const subject = safeLogFragment(set.role);

		if (subjects.has(set.role)) {
			failures.push(identityConflict(`Duplicate permission set for role "${subject}".`));
		}

		subjects.add(set.role);

		if (set.role !== PUBLIC_ROLE_KEY) {
			if (managed.has('roles')) {
				if (!declaredRoleKeys.has(set.role)) {
					failures.push(invalid(`Permission set references role "${subject}", which no role file declares.`));
				}
			} else if (!context.currentRoleKeys.has(set.role)) {
				failures.push(invalid(`Permission set references role "${subject}", which does not exist in the database.`));
			}
		}

		const tuples = new Set<string>();

		for (const permission of set.permissions) {
			const tuple = `${permission.collection}:${permission.action}`;

			if (tuples.has(tuple)) {
				failures.push(
					identityConflict(
						`Duplicate permission for role "${subject}": collection "${safeLogFragment(
							permission.collection
						)}", action "${safeLogFragment(permission.action)}".`
					)
				);
			}

			tuples.add(tuple);
		}
	}

	return failures;
}
