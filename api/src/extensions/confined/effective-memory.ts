/** The memory the sandbox sizes its concurrency against: the process's cgroup memory limit
 * (v2 `memory.max` or v1 `memory.limit_in_bytes`) when it is a finite limit below the host
 * total, else the host total. In a memory-limited container the host total would overstate
 * what is available, so the cgroup limit is read first. The file reads are injected so the
 * interpretation is testable without a real cgroup. */

import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';
import { join } from 'node:path';

export interface EffectiveMemoryDeps {
	readFile: (path: string) => string | null;
	totalMemory: () => number;
}

const realDeps: EffectiveMemoryDeps = {
	readFile: (path) => {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return null;
		}
	},
	totalMemory: totalmem,
};

export function detectEffectiveMemory(deps: EffectiveMemoryDeps = realDeps): number {
	const total = deps.totalMemory();
	const limit = cgroupV2Limit(deps) ?? cgroupV1Limit(deps);
	// A cgroup "unlimited" is a huge sentinel that fails the safe-integer guard or exceeds the
	// host, so it collapses to the host total here.
	return limit !== null && limit < total ? limit : total;
}

function cgroupV2Limit(deps: EffectiveMemoryDeps): number | null {
	const cgroup = deps.readFile('/proc/self/cgroup');
	if (cgroup === null) return null;

	const line = cgroup.split('\n').find((entry) => entry.startsWith('0::'));
	if (line === undefined) return null;

	const raw = deps.readFile(join('/sys/fs/cgroup', line.slice('0::'.length), 'memory.max'));
	return raw === null || raw.trim() === 'max' ? null : toBytes(raw);
}

function cgroupV1Limit(deps: EffectiveMemoryDeps): number | null {
	const cgroup = deps.readFile('/proc/self/cgroup');
	if (cgroup === null) return null;

	const line = cgroup.split('\n').find((entry) => entry.split(':')[1]?.split(',').includes('memory'));
	if (line === undefined) return null;

	const raw = deps.readFile(join('/sys/fs/cgroup/memory', line.split(':').slice(2).join(':'), 'memory.limit_in_bytes'));
	return raw === null ? null : toBytes(raw);
}

function toBytes(raw: string): number | null {
	const value = Number(raw.trim());
	return Number.isSafeInteger(value) && value > 0 ? value : null;
}
