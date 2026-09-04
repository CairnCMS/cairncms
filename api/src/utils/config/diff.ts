import { isEqual } from 'lodash-es';
import type { ConfigKindTypes, ConfigResourceDescriptor, KindPlan } from './descriptor.js';
import { orderedValueFields } from './values.js';

/** Descriptor fields used to compare canonical record values. */
export type RecordValueDiffInput<K extends ConfigKindTypes> = Pick<
	ConfigResourceDescriptor<K>,
	'recordFields' | 'valueFieldOrder' | 'canonicalizeValues'
>;

/**
 * Field-metadata-driven value diff. Iterates the canonical value-field order, comparing each mutable field
 * unless it is omitted and preserves the current value. The Values/Changes casts are the contained metadata boundary.
 */
export function diffRecordValues<K extends ConfigKindTypes>(
	descriptor: RecordValueDiffInput<K>,
	current: K['Record'],
	desired: K['Record']
): K['Changes'] {
	const before = descriptor.canonicalizeValues(current) as Record<string, unknown>;
	const after = descriptor.canonicalizeValues(desired) as Record<string, unknown>;
	const desiredRaw = desired as Record<string, unknown>;
	const changes: Record<string, { before: unknown; after: unknown }> = {};

	for (const field of orderedValueFields(descriptor.recordFields, descriptor.valueFieldOrder)) {
		if (!field.mutable) continue;
		if (field.omissionPreservesCurrent && !Object.hasOwn(desiredRaw, field.name)) continue;

		if (!isEqual(before[field.name], after[field.name])) {
			changes[field.name] = { before: before[field.name], after: after[field.name] };
		}
	}

	return changes as K['Changes'];
}

/**
 * Generic per-kind plan: creates and updates in desired-input order, deletes in current-state order, matched by
 * the descriptor's collision-safe identity key. It holds no cascade knowledge. Subsumption is the handler's postPlan.
 */
export function computeKindPlan<K extends ConfigKindTypes>(
	descriptor: ConfigResourceDescriptor<K>,
	currentRecords: K['Record'][],
	desiredRecords: K['Record'][]
): KindPlan<K> {
	const currentByKey = new Map<string, K['Record']>();

	for (const record of currentRecords) {
		currentByKey.set(descriptor.identityKey(descriptor.identityOf(record)), record);
	}

	const plan: KindPlan<K> = { create: [], update: [], delete: [] };
	const desiredKeys = new Set<string>();

	for (const record of desiredRecords) {
		const identity = descriptor.identityOf(record);
		const key = descriptor.identityKey(identity);
		desiredKeys.add(key);

		const current = currentByKey.get(key);

		if (current === undefined) {
			plan.create.push(descriptor.toCreateEntry(record));
			continue;
		}

		const changes = diffRecordValues(descriptor, current, record);

		if (Object.keys(changes as Record<string, unknown>).length > 0) {
			plan.update.push(descriptor.toUpdateEntry(identity, changes));
		}
	}

	for (const record of currentRecords) {
		const identity = descriptor.identityOf(record);

		if (!desiredKeys.has(descriptor.identityKey(identity))) {
			plan.delete.push(descriptor.toDeleteEntry(identity));
		}
	}

	return plan;
}
