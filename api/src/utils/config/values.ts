import type { ConfigFieldDescriptor } from './descriptor.js';

export function sortedOrNull(values: unknown): string[] | null {
	if (values == null) return null;
	return [...(values as string[])].sort();
}

/**
 * Builds a kind's canonical values from its record fields, applying each field's canonicalize.
 * The caller narrows the result to its Values type at the contained metadata boundary.
 */
export function composeValues(
	recordFields: ConfigFieldDescriptor[],
	record: Record<string, unknown>
): Record<string, unknown> {
	const values: Record<string, unknown> = {};

	for (const field of recordFields) {
		if (field.identityComponent) continue;

		const raw = record[field.name];
		values[field.name] = field.canonicalize ? field.canonicalize(raw) : raw;
	}

	return values;
}
