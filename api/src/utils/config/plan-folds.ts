import type { ConfigKind, ConfigPlan } from '../../types/config.js';
import { getDescriptor, listConfigKinds, type ConfigKindTypeMap } from './registry.js';

export type PlanDeletion = {
	[C in ConfigKind]: { kind: C; identity: ConfigKindTypeMap[C]['Identity'] };
}[ConfigKind];

export function isPlanEmpty(plan: ConfigPlan): boolean {
	return listConfigKinds().every((kind) => {
		const slice = plan[kind];
		return slice.create.length === 0 && slice.update.length === 0 && slice.delete.length === 0;
	});
}

export function planSummary(plan: ConfigPlan): { create: number; update: number; delete: number } {
	const summary = { create: 0, update: 0, delete: 0 };

	for (const kind of listConfigKinds()) {
		summary.create += plan[kind].create.length;
		summary.update += plan[kind].update.length;
		summary.delete += plan[kind].delete.length;
	}

	return summary;
}

export function planHasDeletions(plan: ConfigPlan): boolean {
	return listConfigKinds().some((kind) => plan[kind].delete.length > 0);
}

export function planDeletions(plan: ConfigPlan): PlanDeletion[] {
	const deletions: PlanDeletion[] = [];

	for (const kind of listConfigKinds()) {
		const descriptor = getDescriptor(kind);

		for (const entry of plan[kind].delete) {
			const identity = descriptor.identityOfDelete(entry as never);
			deletions.push({ kind, identity } as PlanDeletion);
		}
	}

	return deletions;
}
