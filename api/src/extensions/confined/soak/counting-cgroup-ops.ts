import type { ChildCgroup } from '../sandbox-hardening.js';
import type { ConfinedCgroupOps } from '../supervisor.js';

export interface CgroupTally {
	created: number;
	placed: number;
	removed: number;
	killScope: number;
	pending: number;
	// Per-handle integrity: a place or remove of an unknown handle, or a duplicate place
	// or remove of the same handle. Must be 0.
	unexpectedOps: number;
	// Created handles placed exactly once, and removed exactly once. Each must equal
	// created. Aggregate equality alone would let a double-place of one handle hide a
	// skipped placement of another, so the per-handle counts are the real proof.
	placedExactlyOnce: number;
	removedExactlyOnce: number;
}

export interface CountingCgroupOps {
	ops: ConfinedCgroupOps;
	tally: () => CgroupTally;
}

interface HandleState {
	placed: number;
	removed: number;
}

/**
 * A cgroupOps that records the create, place, remove, and killScope lifecycle per handle
 * rather than only in aggregate, so the soak proves every created cgroup was placed once
 * and removed once with no unknown or duplicate operation. create returns a non-null
 * handle so place and remove are exercised, which keeps the equality a real proof rather
 * than 0 === 0.
 */
export function createCountingCgroupOps(): CountingCgroupOps {
	const handles = new Map<string, HandleState>();
	let created = 0;
	let killScope = 0;
	let unexpectedOps = 0;

	const ops: ConfinedCgroupOps = {
		create: (): ChildCgroup => {
			created += 1;
			const path = `soak-cgroup-${created}`;
			handles.set(path, { placed: 0, removed: 0 });
			return { path };
		},
		place: (cgroup: ChildCgroup): boolean => {
			const state = handles.get(cgroup.path);

			if (state === undefined || state.placed > 0) {
				unexpectedOps += 1;
				return false;
			}

			state.placed += 1;
			return true;
		},
		remove: (cgroup: ChildCgroup): boolean => {
			const state = handles.get(cgroup.path);

			if (state === undefined || state.removed > 0) {
				unexpectedOps += 1;
				return false;
			}

			state.removed += 1;
			return true;
		},
		killScope: (): void => {
			killScope += 1;
		},
	};

	return {
		ops,
		tally: () => {
			let placed = 0;
			let removed = 0;
			let placedExactlyOnce = 0;
			let removedExactlyOnce = 0;

			for (const state of handles.values()) {
				placed += state.placed;
				removed += state.removed;
				if (state.placed === 1) placedExactlyOnce += 1;
				if (state.removed === 1) removedExactlyOnce += 1;
			}

			return {
				created,
				placed,
				removed,
				killScope,
				pending: created - removed,
				unexpectedOps,
				placedExactlyOnce,
				removedExactlyOnce,
			};
		},
	};
}
