import type { ConfigFieldDescriptor } from './descriptor.js';

export function sortedOrNull(values: unknown): string[] | null {
	if (values == null) return null;
	return [...(values as string[])].sort();
}

/** The mutation payload for a field-changes map: each field's `after` value. */
export function changesToValues(changes: Record<string, { before: unknown; after: unknown }>): Record<string, unknown> {
	return Object.fromEntries(Object.entries(changes).map(([field, change]) => [field, change.after]));
}

/** Resolves the value field descriptors in canonical output order. Throws if the order names an unknown field. */
export function orderedValueFields(
	recordFields: ConfigFieldDescriptor[],
	valueFieldOrder: readonly string[]
): ConfigFieldDescriptor[] {
	const byName = new Map(recordFields.map((field) => [field.name, field]));

	return valueFieldOrder.map((name) => {
		const field = byName.get(name);
		if (!field) throw new Error(`Config value-field order names unknown field "${name}".`);
		return field;
	});
}

/**
 * Builds a kind's canonical values in canonical field order, applying each field's canonicalize.
 * The caller narrows the result to its Values type at the contained metadata boundary.
 */
export function composeValues(
	recordFields: ConfigFieldDescriptor[],
	valueFieldOrder: readonly string[],
	record: Record<string, unknown>
): Record<string, unknown> {
	const values: Record<string, unknown> = {};

	for (const field of orderedValueFields(recordFields, valueFieldOrder)) {
		const raw = record[field.name];
		values[field.name] = field.canonicalize ? field.canonicalize(raw) : raw;
	}

	return values;
}
