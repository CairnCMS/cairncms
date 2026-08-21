import { PUBLIC_ROLE_KEY } from '@cairncms/constants';
import { isPlainObject } from 'lodash-es';
import path from 'path';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigPlaceholderUnresolvedException } from '../exceptions/config-placeholder-unresolved.js';
import logger from '../logger.js';
import { safeLogFragment } from './safe-log-fragment.js';
import type { CairnConfig, ConfigKind, ConfigManifest, ConfigPermissionSet, ConfigRole } from '../types/config.js';
import {
	classifyConfigEntry,
	isOwnedConfigFilename,
	readContainedDirectory,
	readContainedFile,
	resolveConfigRoot,
} from './config-path-safety.js';
import { parseConfigYaml } from './parse-config-document.js';
import { validateConfigManifest } from './validate-desired-config.js';

const MANIFEST_FILENAME = 'cairncms-config.yaml';

type NoticeSink = (message: string) => void;

export type ConfigReadOptions = { notice?: NoticeSink };

const ENV_VAR_PATTERN = /^\{\{([A-Z_][A-Z0-9_]*)\}\}$/;

/** Whether a value is the whole-string placeholder form this reader would substitute. */
export function isPlaceholder(value: unknown): boolean {
	return typeof value === 'string' && ENV_VAR_PATTERN.test(value);
}

const PLACEHOLDER_NAMESPACE = 'CAIRNCMS_CONFIG_';

function interpolateEnvVar(value: string, field: string, roleKey: unknown): string {
	const match = value.match(ENV_VAR_PATTERN);
	if (!match) return value;

	const varName = match[1]!;
	const where = `role "${safeLogFragment(roleKey)}" field "${field}"`;

	if (!varName.startsWith(PLACEHOLDER_NAMESPACE)) {
		throw new ConfigInvalidException(
			`${where} references {{${safeLogFragment(varName)}}}, which is outside the ${PLACEHOLDER_NAMESPACE} namespace. ` +
				`Only variables in that namespace are substituted.`
		);
	}

	const resolved = process.env[varName];

	if (resolved === undefined) {
		throw new ConfigPlaceholderUnresolvedException(
			`${where} references {{${safeLogFragment(varName)}}}, which has no value in this environment.`
		);
	}

	return resolved;
}

function interpolateRole(role: ConfigRole): ConfigRole {
	const result = { ...role };

	if (typeof result.name === 'string') {
		result.name = interpolateEnvVar(result.name, 'name', role.key);
	}

	if (typeof result.description === 'string') {
		result.description = interpolateEnvVar(result.description, 'description', role.key);
	}

	return result;
}

/** Only a genuinely absent manifest returns null. Every other failure propagates. */
async function readManifestFile(root: string): Promise<ConfigManifest | null> {
	const target = path.join(root, MANIFEST_FILENAME);

	const entry = await classifyConfigEntry(root, target);

	if (entry.kind === 'absent') return null;

	if (entry.kind !== 'file') {
		throw new ConfigInvalidException(`Config manifest "${MANIFEST_FILENAME}" is not a regular file.`);
	}

	const source = await readContainedFile(root, target);

	return validateConfigManifest(parseConfigYaml(source, MANIFEST_FILENAME), MANIFEST_FILENAME);
}

export async function readConfigManifest(root: string): Promise<ConfigManifest> {
	const manifest = await readManifestFile(root);

	if (manifest === null) {
		throw new ConfigInvalidException(
			`Config manifest "${MANIFEST_FILENAME}" was not found. Is this a config directory?`
		);
	}

	return manifest;
}

export async function readOptionalConfigManifest(root: string): Promise<ConfigManifest | null> {
	return readManifestFile(root);
}

/**
 * Record filenames the kind generates, in a stable order. An absent directory yields an empty set,
 * which is the one absence a managed kind may report. Other entries belong to the operator and are
 * left unread, but named, so an intended record that is misfiled does not silently do nothing. The
 * reserved `roles/public.yaml` is the exception and is rejected outright.
 */
async function readKindFilenames(root: string, kind: ConfigKind, notice: NoticeSink): Promise<string[]> {
	const entries = await readContainedDirectory(root, path.join(root, kind));

	if (entries === null) {
		notice(`No ${kind}/ directory in the config tree; treating ${kind} as empty.`);
		return [];
	}

	const owned: string[] = [];

	for (const entry of entries.sort()) {
		if (!entry.endsWith('.yaml')) continue;

		if (kind === 'roles' && entry === `${PUBLIC_ROLE_KEY}.yaml`) {
			throw new ConfigInvalidException(
				`Role key "public" is reserved for public permissions. Remove roles/public.yaml. ` +
					`Public permissions belong in permissions/public.yaml only.`
			);
		}

		if (!isOwnedConfigFilename(entry, kind)) {
			notice(`Ignoring "${kind}/${safeLogFragment(entry)}": not a name this config engine generates.`);
			continue;
		}

		owned.push(entry);
	}

	return owned;
}

async function readRecord(root: string, kind: ConfigKind, filename: string): Promise<unknown> {
	const label = `${kind}/${filename}`;
	const document = await readContainedFile(root, path.join(root, kind, filename));
	const parsed = parseConfigYaml(document, label);

	if (!isPlainObject(parsed)) {
		throw new ConfigInvalidException(`Config document "${label}" must be a mapping.`);
	}

	return parsed;
}

export async function readConfigDirectory(configPath: string, options?: ConfigReadOptions): Promise<CairnConfig> {
	const notice = options?.notice ?? ((message: string) => logger.warn(message));
	const root = await resolveConfigRoot(configPath, 'read');
	const manifest = await readConfigManifest(root);

	const roles: ConfigRole[] = [];
	const permissions: ConfigPermissionSet[] = [];

	if (manifest.resources.includes('roles')) {
		for (const filename of await readKindFilenames(root, 'roles', notice)) {
			const role = (await readRecord(root, 'roles', filename)) as ConfigRole;

			if (!role.key) {
				throw new ConfigInvalidException(`Invalid role file: ${filename} — missing "key" field.`);
			}

			const expectedFilename = `${role.key}.yaml`;

			if (filename !== expectedFilename) {
				throw new ConfigInvalidException(
					`Role file "${filename}" contains key "${role.key}" — filename must match key ("${expectedFilename}").`
				);
			}

			roles.push(interpolateRole(role));
		}
	}

	if (manifest.resources.includes('permissions')) {
		for (const filename of await readKindFilenames(root, 'permissions', notice)) {
			const permSet = (await readRecord(root, 'permissions', filename)) as ConfigPermissionSet;

			if (!permSet.role) {
				throw new ConfigInvalidException(`Invalid permission file: ${filename} — missing "role" field.`);
			}

			if (!Array.isArray(permSet.permissions)) {
				throw new ConfigInvalidException(`Invalid permission file: ${filename} — "permissions" must be an array.`);
			}

			const expectedFilename = `${permSet.role}.yaml`;

			if (filename !== expectedFilename) {
				throw new ConfigInvalidException(
					`Permission file "${filename}" contains role "${permSet.role}" — filename must match role ("${expectedFilename}").`
				);
			}

			permissions.push(permSet);
		}
	}

	return { manifest, roles, permissions };
}
