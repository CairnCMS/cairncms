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
import { PLACEHOLDER_NAMESPACE, placeholderVarName } from './config/placeholder.js';
import { getDescriptor } from './config/registry.js';
import {
	assertContained,
	classifyConfigEntry,
	readContainedDirectory,
	readContainedFile,
	replaceFileAtomically,
} from './config-path-safety.js';
import { assertConfigValueSafe, parseConfigYaml } from './parse-config-document.js';
import { safeLogFragment } from './safe-log-fragment.js';
import { findPlaceholderSyntax } from './validate-desired-config.js';

const MANIFEST_FILENAME = 'cairncms-config.yaml';

const YAML_SUFFIX = '.yaml';

type PendingDocument = { label: string; target: string; document: unknown; kind?: ConfigKind };

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
		const documents = orderedNormalizedDocuments(descriptor, config[kind]);
		const shape = descriptor.layout.documentShape;

		if (typeof shape === 'object' && 'singleton' in shape && documents.length !== 1) {
			throw new ConfigInvalidException(
				`Config ${kind} must resolve to exactly one document, but found ${documents.length}.`
			);
		}

		for (const document of documents) {
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
			pending.push({ label, target, document, kind });
		}
	}

	return { pending, keep };
}

/**
 * Reads the existing on-disk document at a pending target so its committed placeholder declarations can
 * be preserved. Genuine absence is the fresh-export case (null). A relevant source that cannot be parsed
 * safely refuses the whole snapshot before any file is written, so a typo never erases a declaration.
 */
async function readExistingDeclaration(
	root: string,
	target: string,
	label: string
): Promise<Record<string, unknown> | null> {
	const entry = await classifyConfigEntry(root, target);

	if (entry.kind === 'absent') return null;

	if (entry.kind !== 'file') {
		throw new ConfigReadFailedException(`Config path "${safeLogFragment(label)}" is not a regular file.`);
	}

	const source = await readContainedFile(root, target);

	let parsed: unknown;

	try {
		parsed = parseConfigYaml(source, label);
	} catch (err) {
		if (err instanceof ConfigInvalidException) {
			throw new ConfigReadFailedException(
				`Config could not be written: the existing file "${safeLogFragment(
					label
				)}" could not be read to preserve its placeholder declarations (${err.message}). Fix or remove it and retry.`
			);
		}

		throw err;
	}

	return isPlainObject(parsed) ? (parsed as Record<string, unknown>) : null;
}

async function restoreDeclaredPlaceholders(root: string, pending: PendingDocument): Promise<void> {
	if (pending.kind === undefined) return;

	const descriptor = getDescriptor(pending.kind) as ConfigResourceDescriptor<ConfigKindTypes>;

	const placeholderFields = [...descriptor.documentIdentityFields, ...descriptor.recordFields].filter(
		(field) => field.acceptsPlaceholder
	);

	if (placeholderFields.length === 0 && descriptor.restorePlaceholders === undefined) return;

	const existing = await readExistingDeclaration(root, pending.target, pending.label);
	if (existing === null) return;

	// Preserve declarations only from the same identity; a singleton's fixed filename supplies its identity.
	const shape = descriptor.layout.documentShape;
	const isSingleton = typeof shape === 'object' && 'singleton' in shape;
	const stem = path.basename(pending.target).slice(0, -YAML_SUFFIX.length);

	if (!isSingleton && !declaredMatchesFilename(descriptor, existing, stem)) return;

	const document = pending.document as Record<string, unknown>;

	for (const field of placeholderFields) {
		const declared = existing[field.name];
		const varName = placeholderVarName(declared);

		if (varName !== undefined && varName.startsWith(PLACEHOLDER_NAMESPACE)) {
			document[field.name] = declared;
		}
	}

	if (descriptor.restorePlaceholders !== undefined) {
		pending.document = descriptor.restorePlaceholders(pending.document, existing);
	}
}

function declaredMatchesFilename(
	descriptor: ConfigResourceDescriptor<ConfigKindTypes>,
	declared: unknown,
	stem: string
): boolean {
	if (!isPlainObject(declared)) return false;

	const shape = descriptor.layout.documentShape;

	if (typeof shape === 'object' && 'nestedMap' in shape) {
		try {
			return descriptor.layout.filenameOf(descriptor.layout.documentIdentityOf(declared as never)) === stem;
		} catch {
			return false;
		}
	}

	return (declared as Record<string, unknown>)[descriptor.documentIdentityFields[0]!.name] === stem;
}

/**
 * Removal requires an owned filename that parses and declares the identity its stem promises. Provenance
 * is not recorded, so a hand-authored record indistinguishable from generated output is removed too.
 */
async function cleanKindDirectory(root: string, kind: ConfigKind, keep: Set<string>): Promise<void> {
	const entries = await readContainedDirectory(root, path.join(root, kind));
	if (entries === null) return;

	const descriptor = getDescriptor(kind) as ConfigResourceDescriptor<ConfigKindTypes>;
	const shape = descriptor.layout.documentShape;

	// A singleton owns only its one fixed file, which is always written and kept, so there is nothing to remove.
	if (typeof shape === 'object' && 'singleton' in shape) return;

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

		if (!declaredMatchesFilename(descriptor, declared, entry.slice(0, -YAML_SUFFIX.length))) {
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

	// After the database values are validated, restore an operator's committed placeholder declarations from
	// the existing files. A parse failure here refuses before any write, so nothing is serialized yet.
	for (const entry of pending) {
		await restoreDeclaredPlaceholders(root, entry);
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
