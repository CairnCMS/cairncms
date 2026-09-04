import { promises as fs } from 'fs';
import { dump as toYaml } from 'js-yaml';
import { isPlainObject } from 'lodash-es';
import path from 'path';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import logger from '../logger.js';
import { CONFIG_KINDS, type CairnConfig, type ConfigKind } from '../types/config.js';
import type { ConfigKindTypes, ConfigResourceDescriptor } from './config/descriptor.js';
import {
	isOwnedConfigFilename,
	normalizeStringListFields,
	orderedDocuments,
	orderedRecords,
} from './config/directory-layout.js';
import { getDescriptor } from './config/registry.js';
import {
	assertContained,
	readContainedDirectory,
	readContainedFile,
	replaceFileAtomically,
} from './config-path-safety.js';
import { assertConfigValueSafe, parseConfigYaml } from './parse-config-document.js';
import { safeLogFragment } from './safe-log-fragment.js';
import { findPlaceholderSyntax } from './validate-desired-config.js';

const MANIFEST_FILENAME = 'cairncms-config.yaml';

const YAML_SUFFIX = '.yaml';

type PendingDocument = { label: string; target: string; document: unknown };

function dumpYaml(data: unknown): string {
	return toYaml(data, { indent: 2, sortKeys: true, lineWidth: -1, noRefs: true });
}

/**
 * Canonical documents for one kind: `projectDocuments` lifts grouped records to their full identity,
 * they are ordered and their string-list fields sorted, then `composeDocuments` rebuilds them (empty
 * sets preserved through anchors) and `orderedDocuments` fixes the on-disk file order.
 */
function orderedNormalizedDocuments(
	descriptor: ConfigResourceDescriptor<ConfigKindTypes>,
	documents: unknown[]
): unknown[] {
	const { records, anchors } = descriptor.projectDocuments(documents);
	const ordered = orderedRecords(descriptor, records);
	const normalized = ordered.map((record) => normalizeStringListFields(descriptor.recordFields, record));

	return orderedDocuments(descriptor, descriptor.composeDocuments(normalized, anchors));
}

function buildDocuments(config: CairnConfig, root: string): { pending: PendingDocument[]; keep: Set<string> } {
	const managed = new Set<ConfigKind>(config.manifest.resources);

	const pending: PendingDocument[] = [
		{ label: MANIFEST_FILENAME, target: path.join(root, MANIFEST_FILENAME), document: config.manifest },
	];

	const keep = new Set<string>();

	for (const kind of CONFIG_KINDS) {
		if (!managed.has(kind)) continue;

		const descriptor = getDescriptor(kind) as ConfigResourceDescriptor<ConfigKindTypes>;

		for (const document of orderedNormalizedDocuments(descriptor, config[kind])) {
			const filename = `${descriptor.layout.filenameOf(descriptor.layout.documentIdentityOf(document))}${YAML_SUFFIX}`;
			const label = `${kind}/${filename}`;

			if (!isOwnedConfigFilename(filename, kind)) {
				throw new ConfigInvalidException(
					`Config ${kind} document resolves to "${safeLogFragment(
						filename
					)}", which is not a filename this config engine generates.`
				);
			}

			if (keep.has(label)) {
				throw new ConfigInvalidException(
					`Config declares a duplicate ${kind} identity "${safeLogFragment(filename)}".`
				);
			}

			const target = path.join(root, kind, filename);
			assertContained(path.join(root, kind), target, label);

			keep.add(label);
			pending.push({ label, target, document });
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

	const identityField = getDescriptor(kind).documentIdentityFields[0]!.name;

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

		const identity = isPlainObject(declared) ? (declared as Record<string, unknown>)[identityField] : undefined;

		if (identity !== entry.slice(0, -YAML_SUFFIX.length)) {
			logger.warn(`Leaving "${label}": it does not declare the identity its filename promises.`);
			continue;
		}

		await fs.unlink(target);
	}
}

export async function writeConfigDirectory(config: CairnConfig, root: string): Promise<void> {
	const { pending, keep } = buildDocuments(config, root);

	const placeholders = findPlaceholderSyntax(config);

	if (placeholders.length > 0) {
		throw new ConfigReadFailedException(
			`Config could not be written: ${placeholders.join('; ')}. The config format substitutes that form on read.`
		);
	}

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
