import { promises as fs } from 'fs';
import { dump as toYaml } from 'js-yaml';
import { isPlainObject } from 'lodash-es';
import path from 'path';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import logger from '../logger.js';
import {
	CONFIG_KINDS,
	type CairnConfig,
	type ConfigKind,
	type ConfigPermission,
	type ConfigPermissionSet,
} from '../types/config.js';
import {
	isOwnedConfigFilename,
	readContainedDirectory,
	readContainedFile,
	replaceFileAtomically,
} from './config-path-safety.js';
import { assertConfigValueSafe, parseConfigYaml } from './parse-config-document.js';
import { safeLogFragment } from './safe-log-fragment.js';

const MANIFEST_FILENAME = 'cairncms-config.yaml';

const YAML_SUFFIX = '.yaml';

const IDENTITY_FIELD: Record<ConfigKind, string> = { roles: 'key', permissions: 'role' };

type PendingDocument = { label: string; target: string; document: unknown };

function sortStringArray(arr: string[] | null | undefined): string[] | null {
	if (!arr) return null;
	return [...arr].sort();
}

function sortPermissions(permissions: ConfigPermission[]): ConfigPermission[] {
	return [...permissions]
		.sort((a, b) => {
			const cmp = a.collection.localeCompare(b.collection);
			if (cmp !== 0) return cmp;
			return a.action.localeCompare(b.action);
		})
		.map((p) => ({ ...p, fields: sortStringArray(p.fields) }));
}

function dumpYaml(data: unknown): string {
	return toYaml(data, { indent: 2, sortKeys: true, lineWidth: -1, noRefs: true });
}

function buildDocuments(config: CairnConfig, root: string): { pending: PendingDocument[]; keep: Set<string> } {
	const managed = new Set<ConfigKind>(config.manifest.resources);

	const pending: PendingDocument[] = [
		{ label: MANIFEST_FILENAME, target: path.join(root, MANIFEST_FILENAME), document: config.manifest },
	];

	const keep = new Set<string>();

	if (managed.has('roles')) {
		for (const role of [...config.roles].sort((a, b) => a.key.localeCompare(b.key))) {
			const filename = `${role.key}${YAML_SUFFIX}`;
			keep.add(`roles/${filename}`);

			const normalized = { ...role };
			if (normalized.ip_access) normalized.ip_access = sortStringArray(normalized.ip_access);

			pending.push({
				label: `roles/${filename}`,
				target: path.join(root, 'roles', filename),
				document: normalized,
			});
		}
	}

	if (managed.has('permissions')) {
		for (const permSet of [...config.permissions].sort((a, b) => a.role.localeCompare(b.role))) {
			const filename = `${permSet.role}${YAML_SUFFIX}`;
			keep.add(`permissions/${filename}`);

			const sorted: ConfigPermissionSet = {
				role: permSet.role,
				permissions: sortPermissions(permSet.permissions),
			};

			pending.push({
				label: `permissions/${filename}`,
				target: path.join(root, 'permissions', filename),
				document: sorted,
			});
		}
	}

	return { pending, keep };
}

/**
 * Removal requires an owned filename that parses and declares the identity its stem promises. Provenance
 * is not recorded, so a hand-authored record indistinguishable from generated output is removed too.
 */
async function cleanKindDirectory(root: string, kind: ConfigKind, keep: Set<string>): Promise<void> {
	const entries = await readContainedDirectory(root, path.join(root, kind));
	if (entries === null) return;

	for (const entry of entries.sort()) {
		const label = `${kind}/${entry}`;

		if (!entry.endsWith(YAML_SUFFIX) || keep.has(label)) continue;

		if (!isOwnedConfigFilename(entry, kind)) {
			logger.warn(`Leaving "${kind}/${safeLogFragment(entry)}": not a name this config engine generates.`);
			continue;
		}

		const target = path.join(root, kind, entry);
		const source = await readContainedFile(root, target);

		let declared: unknown;

		try {
			declared = parseConfigYaml(source, label);
		} catch (err) {
			if (!(err instanceof ConfigInvalidException)) throw err;

			logger.warn(`Leaving "${label}": it does not read as a config record.`);
			continue;
		}

		const identity = isPlainObject(declared) ? (declared as Record<string, unknown>)[IDENTITY_FIELD[kind]] : undefined;

		if (identity !== entry.slice(0, -YAML_SUFFIX.length)) {
			logger.warn(`Leaving "${label}": it does not declare the identity its filename promises.`);
			continue;
		}

		await fs.unlink(target);
	}
}

export async function writeConfigDirectory(config: CairnConfig, root: string): Promise<void> {
	const { pending, keep } = buildDocuments(config, root);

	// The checks protect the serializer, so every document is validated before any is serialized or written.
	for (const { label, document } of pending) {
		try {
			assertConfigValueSafe(document, label);
		} catch (err) {
			if (err instanceof ConfigInvalidException) throw new ConfigReadFailedException(err.message);
			throw err;
		}
	}

	const serialized = pending.map(({ label, target, document }) => {
		try {
			return { target, contents: dumpYaml(document) };
		} catch (err) {
			throw new ConfigReadFailedException(
				`Config document "${safeLogFragment(label)}" could not be serialized: ${safeLogFragment(
					(err as Error).message
				)}.`
			);
		}
	});

	const managed = new Set<ConfigKind>(config.manifest.resources);

	for (const kind of CONFIG_KINDS) {
		if (managed.has(kind)) await fs.mkdir(path.join(root, kind), { recursive: true });
	}

	for (const { target, contents } of serialized) {
		await replaceFileAtomically(root, target, contents);
	}

	for (const kind of CONFIG_KINDS) {
		if (managed.has(kind)) await cleanKindDirectory(root, kind, keep);
	}
}
