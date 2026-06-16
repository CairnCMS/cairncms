import { describe, expect, it } from 'vitest';
import {
	buildHardenedSpawn,
	candidateLayerSets,
	describePosture,
	detectCapabilities,
	generateScopeUnit,
	reconcilePosture,
	resolveHardeningPosture,
	validateComposedHardening,
	type CgroupMechanic,
	type HardeningCapabilities,
	type HardeningLayer,
	type HardenedSpawn,
	type HardenedSpawnSpec,
	type HardeningMode,
	type SandboxPosture,
} from './sandbox-hardening.js';

function caps(layers: HardeningLayer[], mechanic: CgroupMechanic = 'systemd-run'): HardeningCapabilities {
	return {
		networkNamespace: layers.includes('network-namespace'),
		permissionModel: layers.includes('permission-model'),
		cgroupMemory: layers.includes('cgroup-memory') ? { mechanic } : null,
	};
}

function postureFor(
	layers: HardeningLayer[],
	mechanic: CgroupMechanic = 'systemd-run',
	mode: HardeningMode = 'auto'
): SandboxPosture {
	const resolved = resolveHardeningPosture({ EXTENSIONS_SANDBOX_OS_HARDENING: mode }, caps(layers, mechanic));
	if (!resolved.ok) throw new Error('unexpected malformed mode in fixture');
	return resolved.posture;
}

function makeSpec(overrides: Partial<HardenedSpawnSpec> = {}): HardenedSpawnSpec {
	return {
		execPath: '/usr/bin/node',
		childExecArgv: [],
		childPath: '/app/runtime/child-host.mjs',
		runtimeDir: '/app/runtime',
		isBundled: true,
		memoryMaxBytes: 223 * 1024 * 1024,
		scopeUnit: 'cairn-confined-test.scope',
		childEnv: { PATH: '/usr/bin', CONFINED_SANDBOX_LIMITS: '{"maxResultBytes":16}' },
		busEnv: { DBUS_SESSION_BUS_ADDRESS: 'unix:/run/bus', XDG_RUNTIME_DIR: '/run/user/1000' },
		...overrides,
	};
}

const FULL: HardeningLayer[] = ['network-namespace', 'permission-model', 'cgroup-memory'];

describe('resolveHardeningPosture', () => {
	it('treats an unset value as auto', () => {
		const resolved = resolveHardeningPosture({}, caps(FULL));
		expect(resolved).toMatchObject({ ok: true });
		if (resolved.ok) expect(resolved.posture.mode).toBe('auto');
	});

	it('treats an empty or whitespace value as auto', () => {
		for (const raw of ['', '   ']) {
			const resolved = resolveHardeningPosture({ EXTENSIONS_SANDBOX_OS_HARDENING: raw }, caps(FULL));
			expect(resolved.ok && resolved.posture.mode).toBe('auto');
		}
	});

	it('composes every available layer and reports the core satisfied with full capabilities', () => {
		const resolved = resolveHardeningPosture({ EXTENSIONS_SANDBOX_OS_HARDENING: 'auto' }, caps(FULL));

		expect(resolved.ok && resolved.posture).toMatchObject({
			applied: FULL,
			missing: [],
			coreSatisfied: true,
			decision: 'run',
			cgroupMechanic: 'systemd-run',
		});
	});

	it('normalizes applied and missing into a stable layer order regardless of capability order', () => {
		const resolved = resolveHardeningPosture({}, caps(['permission-model', 'cgroup-memory']));
		expect(resolved.ok && resolved.posture.applied).toEqual(['permission-model', 'cgroup-memory']);
		expect(resolved.ok && resolved.posture.missing).toEqual(['network-namespace']);
	});

	it('nulls the cgroup mechanic when the cgroup layer is unavailable', () => {
		const resolved = resolveHardeningPosture({}, caps(['network-namespace', 'permission-model']));
		expect(resolved.ok && resolved.posture.cgroupMechanic).toBeNull();
	});

	it('carries the delegated-cgroup mechanic through', () => {
		const resolved = resolveHardeningPosture({}, caps(FULL, 'delegated-cgroup'));
		expect(resolved.ok && resolved.posture.cgroupMechanic).toBe('delegated-cgroup');
	});

	it('runs in auto even when no layer is available', () => {
		const resolved = resolveHardeningPosture({ EXTENSIONS_SANDBOX_OS_HARDENING: 'auto' }, caps([]));
		expect(resolved.ok && resolved.posture).toMatchObject({ applied: [], coreSatisfied: false, decision: 'run' });
	});

	it('refuses in required mode when a core layer is missing', () => {
		for (const layers of [['permission-model'], ['network-namespace'], ['cgroup-memory'], []] as HardeningLayer[][]) {
			const resolved = resolveHardeningPosture({ EXTENSIONS_SANDBOX_OS_HARDENING: 'required' }, caps(layers));
			expect(resolved.ok && resolved.posture.decision).toBe('refuse');
		}
	});

	it('runs in required mode when the core is satisfied even without the cgroup cap', () => {
		const resolved = resolveHardeningPosture(
			{ EXTENSIONS_SANDBOX_OS_HARDENING: 'required' },
			caps(['network-namespace', 'permission-model'])
		);

		expect(resolved.ok && resolved.posture).toMatchObject({ coreSatisfied: true, decision: 'run' });
	});

	it('returns a structured error for a malformed mode, echoing the raw value', () => {
		const resolved = resolveHardeningPosture({ EXTENSIONS_SANDBOX_OS_HARDENING: 'enabled' }, caps(FULL));
		expect(resolved.ok).toBe(false);

		if (!resolved.ok) {
			expect(resolved.error.envVar).toBe('EXTENSIONS_SANDBOX_OS_HARDENING');
			expect(resolved.error.message).toContain('enabled');
		}
	});
});

describe('reconcilePosture', () => {
	it('downgrades the decision when validation drops a core layer in required mode', () => {
		const intended = postureFor(FULL, 'systemd-run', 'required');
		const reconciled = reconcilePosture(intended, ['permission-model', 'cgroup-memory']);

		expect(reconciled).toMatchObject({
			coreSatisfied: false,
			decision: 'refuse',
			applied: ['permission-model', 'cgroup-memory'],
		});
	});

	it('keeps the core satisfied and nulls the mechanic when only the cgroup layer drops', () => {
		const intended = postureFor(FULL, 'systemd-run', 'required');
		const reconciled = reconcilePosture(intended, ['network-namespace', 'permission-model']);
		expect(reconciled).toMatchObject({ coreSatisfied: true, decision: 'run', cgroupMechanic: null });
	});

	it('preserves the mechanic when the cgroup layer is retained', () => {
		const intended = postureFor(FULL, 'delegated-cgroup');
		const reconciled = reconcilePosture(intended, FULL);
		expect(reconciled.cgroupMechanic).toBe('delegated-cgroup');
	});
});

describe('candidateLayerSets', () => {
	it('orders the full set most protection first, then drops the cgroup, then each core layer alone, then none', () => {
		expect(candidateLayerSets(FULL)).toEqual([
			['network-namespace', 'permission-model', 'cgroup-memory'],
			['network-namespace', 'permission-model'],
			['permission-model'],
			['network-namespace'],
			[],
		]);
	});

	it('emits only subsets of the intended set', () => {
		const intended: HardeningLayer[] = ['permission-model', 'cgroup-memory'];

		for (const candidate of candidateLayerSets(intended)) {
			for (const layer of candidate) expect(intended).toContain(layer);
		}
	});

	it('de-dupes when an absent layer collapses a candidate into an earlier one', () => {
		expect(candidateLayerSets(['permission-model'])).toEqual([['permission-model'], []]);
		expect(candidateLayerSets([])).toEqual([[]]);
		expect(candidateLayerSets(['network-namespace'])).toEqual([['network-namespace'], []]);
	});
});

describe('buildHardenedSpawn', () => {
	it('returns the plain baseline on the dev path regardless of posture', () => {
		const spec = makeSpec({
			isBundled: false,
			childExecArgv: ['--loader', 'tsx'],
			childPath: '/app/src/child-host.ts',
		});

		const spawned = buildHardenedSpawn(postureFor(FULL), spec);

		expect(spawned).toEqual({
			command: '/usr/bin/node',
			args: ['--loader', 'tsx', '/app/src/child-host.ts'],
			env: { PATH: '/usr/bin', CONFINED_SANDBOX_LIMITS: '{"maxResultBytes":16}' },
			scopeUnit: null,
		});
	});

	it('runs the bare child when no layer applies', () => {
		const spawned = buildHardenedSpawn(postureFor([]), makeSpec());
		expect(spawned).toMatchObject({ command: '/usr/bin/node', args: ['/app/runtime/child-host.mjs'], scopeUnit: null });
	});

	it('adds the runtime-dir-scoped permission flags for the permission layer', () => {
		const spawned = buildHardenedSpawn(postureFor(['permission-model']), makeSpec());

		expect(spawned).toMatchObject({
			command: '/usr/bin/node',
			args: ['--permission', '--allow-fs-read=/app/runtime', '/app/runtime/child-host.mjs'],
		});
	});

	it('wraps the child in a private network namespace for the namespace layer', () => {
		const spawned = buildHardenedSpawn(postureFor(['network-namespace']), makeSpec());

		expect(spawned).toMatchObject({
			command: 'unshare',
			args: ['-rn', '/usr/bin/node', '/app/runtime/child-host.mjs'],
		});
	});

	it('composes the namespace around the permission model for the core', () => {
		const spawned = buildHardenedSpawn(postureFor(['network-namespace', 'permission-model']), makeSpec());

		expect(spawned).toMatchObject({
			command: 'unshare',
			args: ['-rn', '/usr/bin/node', '--permission', '--allow-fs-read=/app/runtime', '/app/runtime/child-host.mjs'],
			scopeUnit: null,
		});
	});

	it('wraps the full core in a systemd-run scope and interposes env -i', () => {
		const spawned = buildHardenedSpawn(postureFor(FULL, 'systemd-run'), makeSpec());

		expect(spawned).toEqual({
			command: 'systemd-run',
			args: [
				'--user',
				'--scope',
				'--unit=cairn-confined-test.scope',
				'-p',
				'MemoryMax=233832448',
				'-p',
				'MemorySwapMax=0',
				'env',
				'-i',
				'PATH=/usr/bin',
				'CONFINED_SANDBOX_LIMITS={"maxResultBytes":16}',
				'unshare',
				'-rn',
				'/usr/bin/node',
				'--permission',
				'--allow-fs-read=/app/runtime',
				'/app/runtime/child-host.mjs',
			],
			env: {
				PATH: '/usr/bin',
				CONFINED_SANDBOX_LIMITS: '{"maxResultBytes":16}',
				DBUS_SESSION_BUS_ADDRESS: 'unix:/run/bus',
				XDG_RUNTIME_DIR: '/run/user/1000',
			},
			scopeUnit: 'cairn-confined-test.scope',
		});
	});

	it('keeps the session bus on the wrapper env but off the child via env -i', () => {
		const spawned = buildHardenedSpawn(postureFor(FULL, 'systemd-run'), makeSpec());
		const busInArgs = spawned.args.filter((arg) => arg.startsWith('DBUS_') || arg.startsWith('XDG_'));
		expect(busInArgs).toEqual([]);
		expect(spawned.env).toMatchObject({ DBUS_SESSION_BUS_ADDRESS: 'unix:/run/bus', XDG_RUNTIME_DIR: '/run/user/1000' });
	});

	it('wraps a cgroup-only posture in systemd-run with no namespace or permission flags', () => {
		const spawned = buildHardenedSpawn(postureFor(['cgroup-memory'], 'systemd-run'), makeSpec());
		expect(spawned.command).toBe('systemd-run');
		expect(spawned.args).not.toContain('unshare');
		expect(spawned.args).not.toContain('--permission');
		expect(spawned.args.slice(-2)).toEqual(['/usr/bin/node', '/app/runtime/child-host.mjs']);
	});

	it('omits the systemd-run wrapper for the delegated-cgroup mechanic', () => {
		const spawned = buildHardenedSpawn(postureFor(FULL, 'delegated-cgroup'), makeSpec());

		expect(spawned).toMatchObject({
			command: 'unshare',
			args: ['-rn', '/usr/bin/node', '--permission', '--allow-fs-read=/app/runtime', '/app/runtime/child-host.mjs'],
			scopeUnit: null,
		});

		expect(spawned.env).not.toHaveProperty('DBUS_SESSION_BUS_ADDRESS');
	});

	it('passes the per-invocation memory cap into MemoryMax', () => {
		const spawned = buildHardenedSpawn(
			postureFor(FULL, 'systemd-run'),
			makeSpec({ memoryMaxBytes: 500 * 1024 * 1024 })
		);

		expect(spawned.args).toContain('MemoryMax=524288000');
	});

	it('reduces the bundled child env to the allowlist, dropping NODE_PATH and NODE_OPTIONS the caller passes', () => {
		const spec = makeSpec({
			childEnv: {
				PATH: '/usr/bin',
				CONFINED_SANDBOX_LIMITS: '{"maxResultBytes":16}',
				NODE_PATH: '/app/node_modules',
				NODE_OPTIONS: '--max-old-space-size=4096',
			},
		});

		const spawned = buildHardenedSpawn(postureFor(FULL, 'systemd-run'), spec);
		const envI = spawned.args.slice(spawned.args.indexOf('-i') + 1, spawned.args.indexOf('unshare'));

		expect(envI).toEqual(['PATH=/usr/bin', 'CONFINED_SANDBOX_LIMITS={"maxResultBytes":16}']);
		expect(spawned.env).not.toHaveProperty('NODE_PATH');
		expect(spawned.env).not.toHaveProperty('NODE_OPTIONS');
	});

	it('forwards the full env on the dev path, where tsx resolves through node_modules', () => {
		const spec = makeSpec({
			isBundled: false,
			childExecArgv: ['--loader', 'tsx'],
			childPath: '/app/src/child-host.ts',
			childEnv: { PATH: '/usr/bin', NODE_PATH: '/app/node_modules' },
		});

		const spawned = buildHardenedSpawn(postureFor([]), spec);
		expect(spawned.env).toEqual({ PATH: '/usr/bin', NODE_PATH: '/app/node_modules' });
	});
});

describe('describePosture', () => {
	it('renders the full posture with applied, missing, and the mechanic', () => {
		expect(describePosture(postureFor(FULL, 'systemd-run'))).toBe(
			'confined OS hardening: mode=auto decision=run applied=[network-namespace, permission-model, cgroup-memory] missing=[none] cgroup=systemd-run'
		);
	});

	it('renders none for an empty applied or missing set and omits an absent mechanic', () => {
		expect(describePosture(postureFor([]))).toBe(
			'confined OS hardening: mode=auto decision=run applied=[none] missing=[network-namespace, permission-model, cgroup-memory]'
		);
	});
});

describe('generateScopeUnit', () => {
	it('produces a scope-suffixed unit name', () => {
		expect(generateScopeUnit()).toMatch(/^cairn-confined-[0-9a-f-]+\.scope$/);
	});

	it('produces a fresh unit name on each call', () => {
		expect(generateScopeUnit()).not.toBe(generateScopeUnit());
	});
});

describe('validateComposedHardening', () => {
	const permissionOnly = (spawned: HardenedSpawn) =>
		spawned.command === '/usr/bin/node' && spawned.args.includes('--permission') && !spawned.args.includes('-rn');

	it('returns the first candidate whose probe succeeds and stops probing there', async () => {
		const probed: HardenedSpawn[] = [];

		const probe = async (spawned: HardenedSpawn) => {
			probed.push(spawned);
			return permissionOnly(spawned);
		};

		const validated = await validateComposedHardening(postureFor(FULL, 'systemd-run'), makeSpec(), probe);

		expect(validated).toEqual(['permission-model']);
		expect(probed.map((spawned) => spawned.command)).toEqual(['systemd-run', 'unshare', '/usr/bin/node']);
	});

	it('returns the full set without probing further when the first candidate succeeds', async () => {
		const probed: HardenedSpawn[] = [];

		const validated = await validateComposedHardening(postureFor(FULL, 'systemd-run'), makeSpec(), async (spawned) => {
			probed.push(spawned);
			return true;
		});

		expect(validated).toEqual(['network-namespace', 'permission-model', 'cgroup-memory']);
		expect(probed).toHaveLength(1);
	});

	it('returns the empty set when every candidate fails', async () => {
		const validated = await validateComposedHardening(postureFor(FULL, 'systemd-run'), makeSpec(), async () => false);
		expect(validated).toEqual([]);
	});

	it('never probes a cgroup wrapper or claims the cgroup layer under the delegated mechanic', async () => {
		const probed: HardenedSpawn[] = [];

		const validated = await validateComposedHardening(
			postureFor(FULL, 'delegated-cgroup'),
			makeSpec(),
			async (spawned) => {
				probed.push(spawned);
				return false;
			}
		);

		expect(validated).toEqual([]);
		expect(probed.every((spawned) => spawned.command !== 'systemd-run' && spawned.scopeUnit === null)).toBe(true);
	});

	it('validates only the core under the delegated mechanic, never the cgroup', async () => {
		const validated = await validateComposedHardening(
			postureFor(FULL, 'delegated-cgroup'),
			makeSpec(),
			async (spawned) => spawned.command === 'unshare'
		);

		expect(validated).toEqual(['network-namespace', 'permission-model']);
	});
});

describe('detectCapabilities', () => {
	it('returns a well-formed capability record', () => {
		const detected = detectCapabilities();
		expect(typeof detected.networkNamespace).toBe('boolean');
		expect(typeof detected.permissionModel).toBe('boolean');
		expect(detected.cgroupMemory === null || typeof detected.cgroupMemory.mechanic === 'string').toBe(true);
	});
});
