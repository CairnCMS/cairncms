import { isPlainObject, merge } from 'lodash-es';

type FolderReferenceDeclaration = { optionPath: string; referencedKind: 'folder' };

export type FolderReferencePath = (string | number)[];

export type FolderReferenceMeta = { interface?: unknown; options?: unknown; conditions?: unknown };

type Visit = (path: FolderReferencePath, value: unknown) => void;

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
