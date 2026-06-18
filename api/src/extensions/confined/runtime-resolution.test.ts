import { describe, expect, it, vi } from 'vitest';
import type { HardeningCapabilities, HardeningLayer } from './sandbox-hardening.js';
import { resolveConfinedRuntime, type ResolveConfinedRuntimeDeps } from './supervisor.js';

const NO_CAPABILITIES: HardeningCapabilities = {
	networkNamespace: false,
	permissionModel: false,
	cgroupMemory: null,
};

const FULL_CAPABILITIES: HardeningCapabilities = {
	networkNamespace: true,
	permissionModel: true,
	cgroupMemory: { mechanic: 'systemd-run' },
};

const BUNDLED_CHILD = { path: '/runtime/child-host.mjs', execArgv: [], isBundled: true };

// A stub supervisor: resolveConfinedRuntime never spawns when makeSupervisor is
// seamed, so the resolved posture can be inspected without a real child. The child
// defaults to the bundled shape so the OS-hardening layers actually apply, since the
// unbundled child spawns baseline regardless of posture.
function deps(overrides: Partial<ResolveConfinedRuntimeDeps> = {}): ResolveConfinedRuntimeDeps {
	const stubSupervisor = { stub: true } as unknown as ReturnType<
		NonNullable<ResolveConfinedRuntimeDeps['makeSupervisor']>
	>;

	return {
		env: {},
		detect: () => NO_CAPABILITIES,
		validate: async () => [],
		resolveChild: () => BUNDLED_CHILD,
		makeSupervisor: vi.fn(() => stubSupervisor),
		...overrides,
	};
}

describe('resolveConfinedRuntime', () => {
	it('fails on malformed sandbox config, naming the env var', async () => {
		const result = await resolveConfinedRuntime(deps({ env: { EXTENSIONS_SANDBOX_MAX_MEMORY: 'not-a-size' } }));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_MAX_MEMORY');
	});

	it('fails on a malformed hardening mode, naming the env var', async () => {
		const result = await resolveConfinedRuntime(deps({ env: { EXTENSIONS_SANDBOX_OS_HARDENING: 'maybe' } }));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_OS_HARDENING');
	});

	it('builds a baseline supervisor when no hardening is available in auto mode', async () => {
		const makeSupervisor = vi.fn(() => ({} as never));

		const result = await resolveConfinedRuntime(
			deps({ detect: () => NO_CAPABILITIES, validate: async () => [], makeSupervisor })
		);

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.posture.decision).toBe('run');
			expect(result.posture.applied).toEqual([]);
			expect(makeSupervisor).toHaveBeenCalledOnce();
			expect(makeSupervisor.mock.calls[0]![0].posture).toBe(result.posture);
		}
	});

	it('reconciles the posture to the layers the self-check confirmed, not raw availability', async () => {
		// Capabilities report all three, but the composed self-check only confirms
		// the two-layer core, so the reconciled posture must drop the cgroup layer.
		const validated: HardeningLayer[] = ['network-namespace', 'permission-model'];

		const result = await resolveConfinedRuntime(
			deps({ detect: () => FULL_CAPABILITIES, validate: async () => validated })
		);

		expect(result.ok).toBe(true);

		if (result.ok) {
			expect(result.posture.applied).toEqual(validated);
			expect(result.posture.missing).toContain('cgroup-memory');
			expect(result.posture.coreSatisfied).toBe(true);
		}
	});

	it('refuses in required mode when the self-check cannot confirm the core', async () => {
		const result = await resolveConfinedRuntime(
			deps({
				env: { EXTENSIONS_SANDBOX_OS_HARDENING: 'required' },
				detect: () => FULL_CAPABILITIES,
				validate: async () => ['network-namespace'],
			})
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_OS_HARDENING');
	});

	it('passes the validator the spawn spec for the resolved child', async () => {
		const validate = vi.fn(async () => [] as HardeningLayer[]);

		await resolveConfinedRuntime(deps({ validate }));

		expect(validate).toHaveBeenCalledOnce();
		const spec = validate.mock.calls[0]![1];
		expect(spec.childPath).toBe('/runtime/child-host.mjs');
		expect(spec.runtimeDir).toBe('/runtime');
		expect(spec.isBundled).toBe(true);
	});

	it('constructs the supervisor with the exact child the self-check validated', async () => {
		const makeSupervisor = vi.fn(() => ({} as never));
		const child = { path: '/runtime/child-host.mjs', execArgv: ['--x'], isBundled: true };

		const result = await resolveConfinedRuntime(deps({ resolveChild: () => child, makeSupervisor }));

		expect(result.ok).toBe(true);
		const options = makeSupervisor.mock.calls[0]![0];
		expect(options.childPath).toBe(child.path);
		expect(options.childExecArgv).toEqual(child.execArgv);
		expect(options.isBundled).toBe(true);
	});

	it('claims no hardening for an unbundled child in auto mode and never runs the self-check', async () => {
		const validate = vi.fn(async () => ['network-namespace'] as HardeningLayer[]);

		const result = await resolveConfinedRuntime(
			deps({
				detect: () => FULL_CAPABILITIES,
				validate,
				resolveChild: () => ({ path: '/src/child-host.ts', execArgv: ['--loader', 'tsx'], isBundled: false }),
			})
		);

		expect(validate).not.toHaveBeenCalled();
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.posture.applied).toEqual([]);
	});

	it('refuses required mode for an unbundled child that cannot be hardened', async () => {
		const result = await resolveConfinedRuntime(
			deps({
				env: { EXTENSIONS_SANDBOX_OS_HARDENING: 'required' },
				detect: () => FULL_CAPABILITIES,
				validate: async () => ['network-namespace', 'permission-model'],
				resolveChild: () => ({ path: '/src/child-host.ts', execArgv: ['--loader', 'tsx'], isBundled: false }),
			})
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.envVar).toBe('EXTENSIONS_SANDBOX_OS_HARDENING');
	});

	it('returns a structured error rather than rejecting when the self-check throws', async () => {
		const result = await resolveConfinedRuntime(
			deps({
				validate: async () => {
					throw new Error('spawn failed with a host path /home/alison/secret');
				},
			})
		);

		expect(result.ok).toBe(false);

		if (!result.ok) {
			expect(result.error.message).toBe('the confined runtime could not be initialized');
			expect(result.error.message).not.toContain('/home/alison');
		}
	});

	it('returns a structured error rather than rejecting when child resolution throws', async () => {
		const result = await resolveConfinedRuntime(
			deps({
				resolveChild: () => {
					throw new Error('child resolution failed');
				},
			})
		);

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toBe('the confined runtime could not be initialized');
	});
});
