import { normalizeRoleKey } from '@cairncms/utils';
import { ConfigReadFailedException } from '../../exceptions/config-read-failed.js';
import type { ConfigKind } from '../../types/config.js';
import type { ConfigFieldDescriptor, ConfigKindTypes, ConfigResourceDescriptor } from './descriptor.js';
import { getDescriptor } from './registry.js';

export type FilenameClassification = 'reserved' | 'owned' | 'unowned';

const YAML_SUFFIX = '.yaml';

/**
 * Classifies a filename stem against the identity field that names it. Reserved wins first, so a stem
 * the platform reserves never becomes deletable. Ownership is granted only when the field positively
 * declares the expected grammar and a bounded length: absent ownership metadata never broadens
 * ownership, because this decision authorizes stale-file deletion.
 */
export function classifyIdentityStem(stem: string, field: ConfigFieldDescriptor): FilenameClassification {
	if (field.reserved?.includes(stem)) return 'reserved';

	const { grammar, maxLength } = field;

	if (
		grammar === 'role-key' &&
		typeof maxLength === 'number' &&
		Number.isFinite(maxLength) &&
		maxLength > 0 &&
		stem !== '' &&
		stem.length <= maxLength &&
		normalizeRoleKey(stem) === stem
	) {
		return 'owned';
	}

	return 'unowned';
}

export function classifyConfigFilename(filename: string, kind: ConfigKind): FilenameClassification {
	if (!filename.endsWith(YAML_SUFFIX)) return 'unowned';

	const stem = filename.slice(0, -YAML_SUFFIX.length);

	return classifyIdentityStem(stem, getDescriptor(kind).documentIdentityFields[0]!);
}

/** Whether a kind generates the filename, which is what makes it eligible for stale-file cleanup. */
export function isOwnedConfigFilename(filename: string, kind: ConfigKind): boolean {
	return classifyConfigFilename(filename, kind) === 'owned';
}

/** Documents ordered by their filename identity, the order they are written to disk. */
export function orderedDocuments<K extends ConfigKindTypes>(
	descriptor: ConfigResourceDescriptor<K>,
	documents: K['Document'][]
): K['Document'][] {
	const filenameOf = (document: K['Document']): string =>
		descriptor.layout.filenameOf(descriptor.layout.documentIdentityOf(document));

	return [...documents].sort((a, b) => filenameOf(a).localeCompare(filenameOf(b)));
}

/** Flattened records ordered by identity. Records must carry their full identity (as `projectDocuments` produces). */
export function orderedRecords<K extends ConfigKindTypes>(
	descriptor: ConfigResourceDescriptor<K>,
	records: K['Record'][]
): K['Record'][] {
	return [...records].sort((a, b) => descriptor.compareIdentity(descriptor.identityOf(a), descriptor.identityOf(b)));
}

/**
 * Returns a shallow copy with every own-present `string-list` field canonicalized. Absence stays absent
 * and `null` stays `null`, so an omitted optional list is not materialized. A string-list field without
 * a canonicalizer is a bounded failure rather than a silent skip.
 */
export function normalizeStringListFields<T>(fields: readonly ConfigFieldDescriptor[], value: T): T {
	const result: Record<string, unknown> = { ...(value as Record<string, unknown>) };

	for (const field of fields) {
		if (field.type !== 'string-list' || !Object.hasOwn(result, field.name)) continue;

		if (!field.canonicalize) {
			throw new ConfigReadFailedException(`Config field "${field.name}" is a string list without a canonicalizer.`);
		}

		result[field.name] = field.canonicalize(result[field.name]);
	}

	return result as T;
}
