import Joi from 'joi';
import { isPlainObject } from 'lodash-es';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigUnsupportedVersionException } from '../exceptions/config-unsupported-version.js';
import {
	CONFIG_KINDS,
	type CairnConfig,
	type ConfigFailure,
	type ConfigKind,
	type ConfigManifest,
} from '../types/config.js';
import type { ExtensionDeclarationSnapshot, ReferenceStateSource, ValidationContext } from './config/descriptor.js';
import { invalid } from './config/failures.js';
import { buildDocumentSchema, type SchemaMode } from './config/field-schema.js';
import { isPlaceholder } from './config/placeholder.js';
import { getDescriptor, kindsForVersion, listConfigKinds } from './config/registry.js';
import { SUPPORTED_MANIFEST_VERSIONS, type ManifestVersion } from './config-contract.js';
import { replaceControlCharacters, safeLogFragment } from './safe-log-fragment.js';

/** Callers keep the input object, so coercing "false" would validate while the planner sees a truthy string. */
const VALIDATE_OPTIONS = { convert: false, abortEarly: false } as const;

export function buildRecordSchemas(mode: SchemaMode = 'authored'): Record<ConfigKind, Joi.ObjectSchema> {
	return Object.fromEntries(
		listConfigKinds().map((kind) => [kind, buildDocumentSchema(getDescriptor(kind), mode)])
	) as Record<ConfigKind, Joi.ObjectSchema>;
}

const RECORD_SCHEMA: Record<ConfigKind, Joi.ObjectSchema> = buildRecordSchemas('authored');
const SNAPSHOT_RECORD_SCHEMA: Record<ConfigKind, Joi.ObjectSchema> = buildRecordSchemas('snapshot');

function recordSchemas(mode: SchemaMode): Record<ConfigKind, Joi.ObjectSchema> {
	return mode === 'snapshot' ? SNAPSHOT_RECORD_SCHEMA : RECORD_SCHEMA;
}

const MANIFEST = Joi.object({
	version: Joi.valid(...SUPPORTED_MANIFEST_VERSIONS).required(),
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

	if (!(SUPPORTED_MANIFEST_VERSIONS as readonly unknown[]).includes(declared['version'])) {
		throw new ConfigUnsupportedVersionException(
			`Config manifest in ${where} declares version ${
				declared['version'] === undefined ? 'none' : safeLogFragment(declared['version'])
			}. This engine supports versions ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}.`
		);
	}

	const { error } = MANIFEST.validate(declared, VALIDATE_OPTIONS);

	if (error) {
		throw new ConfigInvalidException(`Config manifest in ${where} is invalid: ${messagesOf(error).join('; ')}`);
	}

	const manifest = declared as unknown as ConfigManifest;
	const allowed = new Set<ConfigKind>(kindsForVersion(manifest.version));
	const tooNew = manifest.resources.filter((kind) => !allowed.has(kind));

	if (tooNew.length > 0) {
		throw new ConfigUnsupportedVersionException(
			`Config manifest in ${where} declares version ${manifest.version} but names ${tooNew
				.map((kind) => safeLogFragment(kind))
				.join(', ')}, which require a newer manifest version.`
		);
	}

	return manifest;
}

export function validateConfigRecord(kind: ConfigKind, record: unknown, mode: SchemaMode = 'authored'): string[] {
	return messagesOf(recordSchemas(mode)[kind].validate(record, VALIDATE_OPTIONS).error);
}

export type DesiredConfigContext = {
	label: string;
	/** Target-only context; omitted when validating a portable server snapshot. */
	extensionDeclarations?: ExtensionDeclarationSnapshot;
	currentCollections?: ReadonlySet<string>;
} & ReferenceStateSource;

/**
 * The local reader substitutes a whole-string placeholder in a field that accepts one, so a persisted document
 * holding that form would change meaning on its next read. Each entry names a managed record field that carries it.
 */
export function findPlaceholderSyntax(config: CairnConfig): string[] {
	const problems: string[] = [];

	for (const kind of listConfigKinds()) {
		if (!config.manifest.resources.includes(kind)) continue;

		const descriptor = getDescriptor(kind);

		const fields = [...descriptor.documentIdentityFields, ...descriptor.recordFields].filter(
			(field) => field.acceptsPlaceholder
		);

		if (fields.length === 0) continue;

		const { records } = descriptor.projectDocuments(config[kind] as never);

		for (const record of records) {
			const values = record as unknown as Record<string, unknown>;

			for (const field of fields) {
				if (!isPlaceholder(values[field.name])) continue;

				const identity = Object.values(descriptor.identityOf(record as never) as unknown as Record<string, unknown>)
					.map((part) => safeLogFragment(part))
					.join(' / ');

				problems.push(`${kind} record "${identity}" field "${field.name}" holds placeholder syntax`);
			}
		}
	}

	for (const kind of listConfigKinds()) {
		if (!config.manifest.resources.includes(kind)) continue;

		const { residualPlaceholders } = getDescriptor(kind);
		if (residualPlaceholders !== undefined) problems.push(...residualPlaceholders(config[kind] as never));
	}

	return problems;
}

function envelopeSchema(
	managed: ReadonlySet<ConfigKind>,
	version: ManifestVersion,
	mode: SchemaMode
): Joi.ObjectSchema {
	const schemas = recordSchemas(mode);

	const kinds = Object.fromEntries(
		kindsForVersion(version).map((kind) => [
			kind,
			managed.has(kind) ? Joi.array().items(schemas[kind]).required() : Joi.array().required(),
		])
	);

	return Joi.object({ manifest: Joi.any(), ...kinds });
}

function referenceSource(context: DesiredConfigContext): ReferenceStateSource {
	switch (context.references) {
		case 'current-state':
			return {
				references: 'current-state',
				currentRoleKeys: context.currentRoleKeys,
				currentFolderKeys: context.currentFolderKeys,
				...(context.currentFolderParents !== undefined && {
					currentFolderParents: context.currentFolderParents,
				}),
			};
		case 'server-snapshot':
			return { references: 'server-snapshot' };

		default: {
			const unsupported: never = context;
			throw new Error(`Unsupported role reference source: ${JSON.stringify(unsupported)}`);
		}
	}
}

export function validateDesiredConfig(document: unknown, context: DesiredConfigContext): ConfigFailure[] {
	if (!isPlainObject(document)) {
		throw new ConfigInvalidException(`Config document in ${safeLogFragment(context.label)} must be a mapping.`);
	}

	const body = document as Record<string, unknown>;
	const manifest = validateConfigManifest(body['manifest'], context.label);
	const managed = new Set<ConfigKind>(manifest.resources);
	const mode: SchemaMode = context.references === 'server-snapshot' ? 'snapshot' : 'authored';

	const fieldErrors = messagesOf(
		envelopeSchema(managed, manifest.version, mode).validate(body, VALIDATE_OPTIONS).error
	);

	if (fieldErrors.length > 0) return fieldErrors.map(invalid);

	const rolesManaged = managed.has('roles');

	// When roles are managed, permission subjects resolve only against desired role declarations.
	const declaredRoleKeys = rolesManaged
		? new Set((body['roles'] as Array<{ key: string }>).map((role) => role.key))
		: new Set<string>();

	const foldersManaged = managed.has('folders');

	// When folders are managed, a folder reference resolves only against desired folder declarations.
	const declaredFolderKeys = foldersManaged
		? new Set((body['folders'] as Array<{ key: string }>).map((folder) => folder.key))
		: new Set<string>();

	const validationContext: ValidationContext = {
		rolesManaged,
		declaredRoleKeys,
		foldersManaged,
		declaredFolderKeys,
		...(context.extensionDeclarations !== undefined && { extensionDeclarations: context.extensionDeclarations }),
		...(context.currentCollections !== undefined && { currentCollections: context.currentCollections }),
		...referenceSource(context),
	};

	const failures: ConfigFailure[] = findPlaceholderSyntax({
		manifest,
		roles: (body['roles'] ?? []) as CairnConfig['roles'],
		permissions: (body['permissions'] ?? []) as CairnConfig['permissions'],
		folders: (body['folders'] ?? []) as CairnConfig['folders'],
		settings: (body['settings'] ?? []) as CairnConfig['settings'],
		'extension-settings': (body['extension-settings'] ?? []) as CairnConfig['extension-settings'],
		translations: (body['translations'] ?? []) as CairnConfig['translations'],
	}).map((problem) =>
		invalid(`${problem}, which cannot be stored because the reader would substitute it. Send a resolved value.`)
	);

	for (const kind of listConfigKinds()) {
		if (!managed.has(kind)) continue;

		const descriptor = getDescriptor(kind);
		const documents = body[kind];
		const { records } = descriptor.projectDocuments(documents as never);
		failures.push(...descriptor.handler.validateDesired(documents as never, records as never, validationContext));
	}

	return failures;
}
