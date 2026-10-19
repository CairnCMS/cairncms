import { cloneDeep, isPlainObject } from 'lodash-es';
import { InvalidPayloadException } from '../exceptions/index.js';
import type { Collection, PortableSnapshot, Snapshot, SnapshotField, SnapshotRelation } from '../types/index.js';
import { visitFolderReferences, type FolderReferenceMeta } from './folder-references.js';
import { safeLogFragment } from './safe-log-fragment.js';
import { sanitizeCollection, sanitizeField, sanitizeRelation } from './sanitize-schema.js';

type Attribute = 'meta' | 'schema';

/**
 * Portable snapshots must be reconciled before reference validation and alignment, which depend on the effective interface.
 * Alignment changes only the current side, so inherited folder references cannot safely change interpretation.
 */
export function reconcileDesiredSchema<T extends Snapshot | PortableSnapshot>(current: Snapshot, desired: T): T {
	const currentCollections = new Map((current.collections ?? []).map((entry) => [entry.collection, entry]));

	const currentFields = new Map(
		(current.fields ?? []).map((entry) => [entityKey(entry.collection, entry.field), entry])
	);

	const currentRelations = new Map(
		(current.relations ?? []).map((entry) => [entityKey(entry.collection, entry.field), entry])
	);

	return {
		...desired,
		collections: (desired.collections ?? []).map((entry) => {
			const currentEntry = currentCollections.get(entry.collection);
			return currentEntry ? reconcileCollection(currentEntry, entry) : entry;
		}),
		fields: (desired.fields ?? []).map((entry) => {
			const currentEntry = currentFields.get(entityKey(entry.collection, entry.field));
			return currentEntry ? reconcileField(currentEntry, entry) : entry;
		}),
		relations: (desired.relations ?? []).map((entry) => {
			const currentEntry = currentRelations.get(entityKey(entry.collection, entry.field));
			return currentEntry ? reconcileRelation(currentEntry, entry) : entry;
		}),
	} as T;
}

function reconcileCollection(current: Collection, desired: Collection): Collection {
	const result = cloneDeep(desired);
	const sanitized = sanitizeCollection(current) as Record<string, unknown> | undefined;
	fillOmitted(result as unknown as Record<string, unknown>, sanitized, 'meta');
	fillOmitted(result as unknown as Record<string, unknown>, sanitized, 'schema');
	return result;
}

function reconcileField(current: SnapshotField, desired: SnapshotField): SnapshotField {
	const sanitizeAllSchema = Boolean(current.schema?.is_primary_key) && Boolean(current.schema?.has_auto_increment);
	const result = cloneDeep(desired);
	const sanitized = sanitizeField(current, sanitizeAllSchema) as Record<string, unknown> | undefined;
	fillOmitted(result as unknown as Record<string, unknown>, sanitized, 'meta');
	fillOmitted(result as unknown as Record<string, unknown>, sanitized, 'schema');
	assertFolderBoundaryKept(current, desired, result);
	return result;
}

function reconcileRelation(current: SnapshotRelation, desired: SnapshotRelation): SnapshotRelation {
	const result = cloneDeep(desired);
	const sanitized = sanitizeRelation(current) as Record<string, unknown> | undefined;
	fillOmitted(result as unknown as Record<string, unknown>, sanitized, 'meta');
	fillOmitted(result as unknown as Record<string, unknown>, sanitized, 'schema');
	return result;
}

function fillOmitted(
	target: Record<string, unknown>,
	sanitizedCurrent: Record<string, unknown> | undefined,
	attribute: Attribute
): void {
	if (!Object.hasOwn(target, attribute)) return;

	const declared = target[attribute];
	const source = sanitizedCurrent?.[attribute];
	if (!isPlainObject(declared) || !isPlainObject(source)) return;

	const declaredObject = declared as Record<string, unknown>;
	const sourceObject = source as Record<string, unknown>;

	for (const key of Object.keys(sourceObject)) {
		if (!Object.hasOwn(declaredObject, key)) declaredObject[key] = cloneDeep(sourceObject[key]);
	}
}

function assertFolderBoundaryKept(current: SnapshotField, authored: SnapshotField, reconciled: SnapshotField): void {
	const authoredMeta = authored.meta;
	if (!isPlainObject(authoredMeta)) return;

	const currentReferences = referencePaths(current.meta);
	const reconciledReferences = referencePaths(reconciled.meta);

	for (const serializedPath of currentReferences) {
		if (reconciledReferences.has(serializedPath)) continue;
		refuseBoundaryCrossing(current, authoredMeta as Record<string, unknown>, serializedPath);
	}

	for (const serializedPath of reconciledReferences) {
		if (currentReferences.has(serializedPath)) continue;
		refuseBoundaryCrossing(current, authoredMeta as Record<string, unknown>, serializedPath);
	}
}

function refuseBoundaryCrossing(
	current: SnapshotField,
	authoredMeta: Record<string, unknown>,
	serializedPath: string
): void {
	const carrier = (JSON.parse(serializedPath) as (string | number)[])[0];
	if (typeof carrier !== 'string') return;
	if (Object.hasOwn(authoredMeta, carrier)) return;

	const label = `${safeLogFragment(current.collection)}.${safeLogFragment(current.field)}`;

	throw new InvalidPayloadException(
		`Field "${label}" can't omit "meta.${carrier}" while changing its interface across the folder reference boundary. Restate "meta.${carrier}".`
	);
}

function referencePaths(meta: unknown): Set<string> {
	const paths = new Set<string>();
	if (!isPlainObject(meta)) return paths;
	visitFolderReferences(meta as FolderReferenceMeta, (path) => paths.add(JSON.stringify(path)));
	return paths;
}

function entityKey(collection: string, field: string): string {
	return JSON.stringify([collection, field]);
}
