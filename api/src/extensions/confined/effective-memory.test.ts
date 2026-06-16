import { describe, expect, it } from 'vitest';
import { detectEffectiveMemory, type EffectiveMemoryDeps } from './effective-memory.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

function deps(files: Record<string, string>, total = 16 * GiB): EffectiveMemoryDeps {
	return { readFile: (path) => files[path] ?? null, totalMemory: () => total };
}

const V2_CGROUP = '0::/cairn';

const v2 = (memoryMax: string) =>
	deps({ '/proc/self/cgroup': V2_CGROUP, '/sys/fs/cgroup/cairn/memory.max': memoryMax });

const v1 = (limit: string) =>
	deps({ '/proc/self/cgroup': '12:memory:/cairn', '/sys/fs/cgroup/memory/cairn/memory.limit_in_bytes': limit });

describe('detectEffectiveMemory', () => {
	it('uses a finite cgroup v2 memory.max', () => {
		expect(detectEffectiveMemory(v2('536870912'))).toBe(512 * MiB);
	});

	it('falls back to the host total when v2 memory.max is unlimited', () => {
		expect(detectEffectiveMemory(v2('max'))).toBe(16 * GiB);
	});

	it('falls back when memory.max is unreadable or invalid', () => {
		expect(detectEffectiveMemory(deps({ '/proc/self/cgroup': V2_CGROUP }))).toBe(16 * GiB);
		expect(detectEffectiveMemory(v2('garbage'))).toBe(16 * GiB);
	});

	it('caps a cgroup limit above the host total at the host total', () => {
		expect(detectEffectiveMemory(v2(String(64 * GiB)))).toBe(16 * GiB);
	});

	it('reads a cgroup v1 memory.limit_in_bytes when v2 is absent', () => {
		expect(detectEffectiveMemory(v1('268435456'))).toBe(256 * MiB);
	});

	it('treats the v1 unlimited sentinel as no limit', () => {
		expect(detectEffectiveMemory(v1('9223372036854771712'))).toBe(16 * GiB);
	});

	it('falls back to the host total when no cgroup is readable', () => {
		expect(detectEffectiveMemory(deps({}, 8 * GiB))).toBe(8 * GiB);
	});
});
