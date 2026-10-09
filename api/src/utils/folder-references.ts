import { normalizeConfigKey } from '@cairncms/utils';
import type { Knex } from 'knex';
import { cloneDeep, get, isPlainObject, merge, set } from 'lodash-es';
import { InvalidPayloadException } from '../exceptions/index.js';
import type { Snapshot, SnapshotField } from '../types/index.js';
import { resolveFolderReference } from './config/folder-id-lookup.js';

type FolderReferenceDeclaration = { optionPath: string; referencedKind: 'folder' };

export type FolderReferencePath = (string | number)[];

export type FolderReferenceMeta = { interface?: unknown; options?: unknown; conditions?: unknown };

type Visit = (path: FolderReferencePath, value: unknown) => void;

type FieldReference = { path: FolderReferencePath; value: unknown };

export type UnresolvedFolderReference = { field: string; path: string; value: unknown };

export type FolderKeys = { folderIdByKey: ReadonlyMap<string, string>; folderKeyById: ReadonlyMap<string, string> };

export type KeyFormState = {
	snapshot: Snapshot;
	folderIdByKey: ReadonlyMap<string, string>;
	unresolved: UnresolvedFolderReference[];
};

const FOLDER_OPTION: readonly FolderReferenceDeclaration[] = [{ optionPath: 'folder', referencedKind: 'folder' }];

export const FOLDER_REFERENCE_INTERFACES: ReadonlyMap<string, readonly FolderReferenceDeclaration[]> = new Map([
	['file', FOLDER_OPTION],
	['file-image', FOLDER_OPTION],
	['files', FOLDER_OPTION],
	['input-rich-text-html', FOLDER_OPTION],
	['input-rich-text-md', FOLDER_OPTION],
]);

export function parseJsonColumn(value: unknown): unknown {
	if (typeof value !== 'string') return value;

	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

/**
 * Visits each stored folder reference at its storage path. Values are classified against the merged view a
 * condition produces at runtime, so a partial override inherits the interface of the definition it overrides.
 */
export function visitFolderReferences(meta: FolderReferenceMeta, visit: Visit): void {
	visitMeta(meta, undefined, [], visit);
}

function visitMeta(
	stored: unknown,
	base: Record<string, unknown> | undefined,
	path: FolderReferencePath,
	visit: Visit
) {
	const meta = asRecord(stored);
	if (meta === undefined) return;

	const view = base === undefined ? meta : merge({}, base, meta);
	const options = asRecord(view['options']);

	visitOptions(view['interface'], meta['options'], options, [...path, 'options'], visit);

	if (!Array.isArray(meta['conditions'])) return;

	meta['conditions'].forEach((condition, index) => {
		const override = asRecord(condition)?.['options'];
		const overrideView = asRecord(merge({}, options, asRecord(override)));

		visitOptions(view['interface'], override, overrideView, [...path, 'conditions', index, 'options'], visit);
	});
}

function visitOptions(
	interfaceId: unknown,
	stored: unknown,
	view: Record<string, unknown> | undefined,
	path: FolderReferencePath,
	visit: Visit
): void {
	const options = asRecord(stored);
	if (typeof interfaceId !== 'string' || options === undefined) return;

	for (const { optionPath } of FOLDER_REFERENCE_INTERFACES.get(interfaceId) ?? []) {
		const value = options[optionPath];
		if (value !== undefined && value !== null) visit([...path, optionPath], value);
	}

	if (interfaceId !== 'list' || !Array.isArray(options['fields'])) return;

	const fieldsView = view?.['fields'];
	const viewFields: unknown[] = Array.isArray(fieldsView) ? fieldsView : [];

	options['fields'].forEach((subField, index) => {
		const base = asRecord(asRecord(viewFields[index])?.['meta']);
		visitMeta(asRecord(subField)?.['meta'], base, [...path, 'fields', index, 'meta'], visit);
	});
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return isPlainObject(value) ? (value as Record<string, unknown>) : undefined;
}

export function isFolderKey(value: unknown): value is string {
	return typeof value === 'string' && value !== '' && normalizeConfigKey(value) === value;
}

export async function readFolderKeys(database: Knex): Promise<FolderKeys> {
	const rows = await database.select('id', 'key').from('directus_folders');

	return {
		folderIdByKey: new Map(rows.map((row) => [String(row['key']), String(row['id'])])),
		folderKeyById: new Map(rows.map((row) => [String(row['id']), String(row['key'])])),
	};
}

export async function toKeyFormSnapshot(snapshot: Snapshot, options: { database: Knex }): Promise<KeyFormState> {
	const { folderIdByKey, folderKeyById } = await readFolderKeys(options.database);
	const unresolved: UnresolvedFolderReference[] = [];
	const fields: SnapshotField[] = [];

	for (const field of snapshot.fields) {
		const replacements: FieldReference[] = [];

		for (const { path, value } of fieldReferences(field)) {
			const key = await resolveFolderReference(options.database, folderKeyById, value);

			if (key === undefined) {
				unresolved.push({ field: fieldLabel(field), path: metaPath(path), value });
			} else {
				replacements.push({ path, value: key });
			}
		}

		fields.push(withReplacements(field, replacements));
	}

	return { snapshot: { ...snapshot, fields }, folderIdByKey, unresolved };
}

export function toFolderIds(field: SnapshotField, folderIdByKey: ReadonlyMap<string, string>): SnapshotField {
	const replacements: FieldReference[] = [];

	for (const { path, value } of fieldReferences(field)) {
		if (!isFolderKey(value)) continue;

		const id = folderIdByKey.get(value);
		if (id === undefined) throw unresolvedKey(value, field, path);

		replacements.push({ path, value: id });
	}

	return withReplacements(field, replacements);
}

export function validateFolderReferences(fields: SnapshotField[], folderIdByKey: ReadonlyMap<string, string>): void {
	for (const field of fields) {
		for (const { path, value } of fieldReferences(field)) {
			if (!isFolderKey(value)) {
				throw new InvalidPayloadException(
					`Folder reference ${JSON.stringify(value)} at ${fieldLabel(field)}.${metaPath(path)} is not a folder key.`
				);
			}

			if (!folderIdByKey.has(value)) throw unresolvedKey(value, field, path);
		}
	}
}

/**
 * Puts the stored value back at each key-form reference where the desired field holds a value it does not register,
 * so a value that leaves the registry, such as on a change to an extension interface, compares as the value it holds
 * rather than as a key. A cleared or removed value keeps the key, so the diff shows the key being cleared.
 */
export function alignToDesiredReferences(
	keyFormFields: SnapshotField[],
	storedFields: SnapshotField[],
	desiredFields: SnapshotField[]
): SnapshotField[] {
	const stored = new Map(storedFields.map((field) => [fieldId(field), field]));
	const desired = new Map(desiredFields.map((field) => [fieldId(field), field]));

	return keyFormFields.map((field) => {
		const storedField = stored.get(fieldId(field));
		const desiredField = desired.get(fieldId(field));
		if (storedField === undefined || desiredField === undefined) return field;

		const desiredPaths = new Set(fieldReferences(desiredField).map(({ path }) => JSON.stringify(path)));

		const replacements = fieldReferences(field)
			.filter(({ path }) => !desiredPaths.has(JSON.stringify(path)))
			.filter(({ path }) => get(desiredField.meta, path) !== undefined && get(desiredField.meta, path) !== null)
			.map(({ path }) => ({ path, value: get(storedField.meta, path) }));

		return withReplacements(field, replacements);
	});
}

function fieldId(field: SnapshotField): string {
	return JSON.stringify([field.collection, field.field]);
}

function fieldReferences(field: SnapshotField): FieldReference[] {
	const references: FieldReference[] = [];
	visitFolderReferences(field.meta ?? {}, (path, value) => references.push({ path, value }));
	return references;
}

function withReplacements(field: SnapshotField, replacements: FieldReference[]): SnapshotField {
	if (replacements.length === 0) return field;

	const copy = cloneDeep(field);

	for (const { path, value } of replacements) {
		set(copy.meta, path, value);
	}

	return copy;
}

function unresolvedKey(key: string, field: SnapshotField, path: FolderReferencePath): InvalidPayloadException {
	return new InvalidPayloadException(
		`Folder reference "${key}" could not be resolved. Referenced by: ${fieldLabel(field)}.${metaPath(path)}`
	);
}

function fieldLabel(field: SnapshotField): string {
	return `${field.collection}.${field.field}`;
}

function metaPath(path: FolderReferencePath): string {
	return path.reduce<string>(
		(label, segment) => (typeof segment === 'number' ? `${label}[${segment}]` : `${label}.${segment}`),
		'meta'
	);
}
