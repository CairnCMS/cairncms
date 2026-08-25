import { isPlainObject } from 'lodash-es';
import path from 'path';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import logger from '../logger.js';
import { safeLogFragment } from './safe-log-fragment.js';
import type { CairnConfig, ConfigKind, ConfigManifest, ConfigPermissionSet, ConfigRole } from '../types/config.js';
import { classifyConfigFilename } from './config/directory-layout.js';
import { getDescriptor, listConfigKinds } from './config/registry.js';
import {
	classifyConfigEntry,
	readContainedDirectory,
	readContainedFile,
	resolveConfigRoot,
} from './config-path-safety.js';
import { parseConfigYaml } from './parse-config-document.js';
import { validateConfigManifest } from './validate-desired-config.js';

export { isPlaceholder } from './config/placeholder.js';

const MANIFEST_FILENAME = 'cairncms-config.yaml';

type NoticeSink = (message: string) => void;

export type ConfigReadOptions = { notice?: NoticeSink };

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

/** The rejection message for a reserved filename, from the kind's descriptor, fail-closed if none is declared. */
function reservedMessage(kind: ConfigKind, filename: string): string {
	const { reservedFilenameMessage } = getDescriptor(kind).layout;

	return reservedFilenameMessage
		? reservedFilenameMessage(filename)
		: `Config filename "${safeLogFragment(filename)}" is reserved.`;
}

/**
 * Record filenames the kind generates, in a stable order. An absent directory yields an empty set,
 * which is the one absence a managed kind may report. Unowned entries belong to the operator and are
 * left unread, but named, so an intended record that is misfiled does not silently do nothing. A
 * reserved stem (roles' `public`) is rejected outright.
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

		const classification = classifyConfigFilename(entry, kind);

		if (classification === 'reserved') {
			throw new ConfigInvalidException(reservedMessage(kind, entry));
		}

		if (classification === 'unowned') {
			notice(`Ignoring "${kind}/${safeLogFragment(entry)}": not a name this config engine generates.`);
			continue;
		}

		owned.push(entry);
	}

	return owned;
}

function isMapping(value: unknown): value is Record<string, unknown> {
	return isPlainObject(value);
}

async function readRecord(root: string, kind: ConfigKind, filename: string): Promise<Record<string, unknown>> {
	const label = `${kind}/${filename}`;
	const document = await readContainedFile(root, path.join(root, kind, filename));
	const parsed = parseConfigYaml(document, label);

	if (!isMapping(parsed)) {
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
	const sink: Record<ConfigKind, unknown[]> = { roles, permissions };

	for (const kind of listConfigKinds()) {
		if (!manifest.resources.includes(kind)) continue;

		const descriptor = getDescriptor(kind);

		for (const filename of await readKindFilenames(root, kind, notice)) {
			const record = await readRecord(root, kind, filename);
			sink[kind].push(descriptor.layout.parseDocumentFile(record, filename));
		}
	}

	return { manifest, roles, permissions };
}
