export const BUILT_IN_TARGETS: Record<string, object> = {
	'Object.prototype': Object.prototype,
	'Object.prototype.toString': Object.prototype.toString,
	'Object.prototype.valueOf': Object.prototype.valueOf,
	'Object.prototype.hasOwnProperty': Object.prototype.hasOwnProperty,
	'Function.prototype': Function.prototype,
	'Array.prototype': Array.prototype,
	'Array.prototype.map': Array.prototype.map,
};

type Snapshot = { label: string; target: object; descriptors: Record<PropertyKey, PropertyDescriptor> };

function sameDescriptor(before: PropertyDescriptor, after: PropertyDescriptor): boolean {
	return (
		Object.is(before.value, after.value) &&
		before.get === after.get &&
		before.set === after.set &&
		before.writable === after.writable &&
		before.enumerable === after.enumerable &&
		before.configurable === after.configurable
	);
}

function restore(snapshots: Snapshot[]): string[] {
	const changes: string[] = [];

	for (const { label, target, descriptors } of snapshots) {
		const current = Object.getOwnPropertyDescriptors(target) as Record<PropertyKey, PropertyDescriptor>;

		for (const key of Reflect.ownKeys(current)) {
			if (!Object.hasOwn(descriptors, key)) {
				changes.push(`${label}.${String(key)}`);
				Reflect.deleteProperty(target, key);
			}
		}

		for (const key of Reflect.ownKeys(descriptors)) {
			const before = descriptors[key]!;
			const after = current[key];

			if (!after || !sameDescriptor(before, after)) {
				changes.push(`${label}.${String(key)}`);
				Object.defineProperty(target, key, before);
			}
		}
	}

	return changes;
}

/**
 * Runs `run`, then restores every own property of the given built-ins before returning, so assertions on
 * the reported changes never execute against corrupted globals.
 */
export async function observeBuiltIns<T>(
	targets: Record<string, object>,
	run: () => T | Promise<T>
): Promise<{ result: T; changes: string[] }> {
	const snapshots: Snapshot[] = Object.entries(targets).map(([label, target]) => ({
		label,
		target,
		descriptors: Object.getOwnPropertyDescriptors(target) as Record<PropertyKey, PropertyDescriptor>,
	}));

	let result: T;
	let changes: string[] = [];

	try {
		result = await run();
	} finally {
		changes = restore(snapshots);
	}

	return { result, changes };
}
