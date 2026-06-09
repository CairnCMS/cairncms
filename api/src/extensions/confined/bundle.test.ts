import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it } from 'vitest';
import { confinedRuntimeEsbuildOptions } from '../../../scripts/build-confined-runtime.mjs';
import { createFrameReader, writeFrame } from './transport.js';
import type { ConfinedResult } from './types.js';

const apiRoot = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeDir = fileURLToPath(new URL('../../../dist/extensions/confined/runtime', import.meta.url));
const bundlePath = join(runtimeDir, 'child-host.mjs');
const bundleExists = existsSync(bundlePath);

const POSITIVE_JOB = {
	type: 'job',
	invocation: {
		extensionId: 'local.test',
		contributionId: 'flow-operation.test',
		operationId: 'op-1',
		entrySource:
			"var CairnOperation = (() => { const handler = async ({ options }) => ({ ok: true, amount: options.amount }); return { default: { id: 'flow-operation.test', handler } }; })();",
		options: { amount: 7 },
		input: null,
		accountability: null,
		limits: {
			wallClockMs: 5000,
			cpuTimeoutMs: 2000,
			memoryBytes: 67108864,
			stackBytes: 524288,
			acquireTimeoutMs: 0,
			hostCallTimeoutMs: 5000,
			maxHostCalls: 1000,
			maxInFlightHostCalls: 16,
		},
	},
};

// Spawns the bundled child under `node --permission` with the read scope limited to the
// runtime dir, nothing else. A read outside it (any node_modules resolution) would
// ERR_ACCESS_DENIED and fail to return.
function runBundleUnderRuntimeScope(): Promise<ConfinedResult> {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['--permission', `--allow-fs-read=${runtimeDir}`, bundlePath], {
			stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
			env: {
				PATH: process.env['PATH'],
				CONFINED_SANDBOX_LIMITS: JSON.stringify({
					parentToChildFrameMax: 64 * 1024 * 1024,
					maxResultBytes: 16 * 1024 * 1024,
				}),
			},
		});

		const channel = child.stdio[3] as Duplex;
		channel.on('error', () => undefined);

		const read = createFrameReader({
			maxFrameBytes: 64 * 1024 * 1024,
			onFrame: (message) => {
				const record = message as { type?: string; result?: ConfinedResult };

				if (record.type === 'done' && record.result) {
					resolve(record.result);
					child.kill('SIGKILL');
				}
			},
			onProtocolViolation: () => {
				child.kill('SIGKILL');
				resolve({ ok: false, error: { code: 'crash', message: 'protocol violation' } });
			},
		});

		channel.on('data', read);
		channel.on('close', () => resolve({ ok: false, error: { code: 'crash', message: 'channel closed' } }));
		writeFrame(channel, POSITIVE_JOB, () => undefined);
	});
}

describe('confined runtime bundle', () => {
	const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

	// Build the bundle in memory so these checks always run against the exact esbuild config,
	// independent of whether a dist build is present.
	let bundleText = '';
	let metafileOutput: { imports?: Array<{ path: string; external?: boolean }> } | undefined;

	beforeAll(async () => {
		const result = await build({
			...confinedRuntimeEsbuildOptions(apiRoot),
			outfile: 'child-host.mjs',
			write: false,
			metafile: true,
		});

		bundleText = result.outputFiles?.[0]?.text ?? '';
		metafileOutput = Object.values(result.metafile?.outputs ?? {})[0];
	});

	it('bundles with no non-builtin external imports', () => {
		const externalNonBuiltin = (metafileOutput?.imports ?? []).filter((imp) => imp.external && !builtins.has(imp.path));

		// The bundle's static import graph must not reach node_modules. esbuild's metafile is
		// the authoritative external list (a regex over the output is fooled by the guest
		// virtual-module source strings the wrapper inlines).
		expect(externalNonBuiltin).toEqual([]);
	});

	it('carries exactly the known, accepted computed dynamic imports', () => {
		// Accepted residuals: obfuscated dynamic imports of optional dependencies the confined
		// runtime never uses (rate-limiter-flexible's drizzle-orm DB limiters, the wrapper's
		// typescript transform). They are unreachable on the supported path and fail closed
		// under the read scope, the actual enforcement boundary. The exact count is pinned, so
		// a dep bump that adds another computed import (even a same-shaped one) fails here for
		// review rather than silently entering the bundle. Rewriting dependency source to strip
		// them would be fragile and add no security.
		const accepted = [
			{ name: 'drizzle-orm', pattern: /^`\$\{getPackageName\d*\(\)\}`/, count: 2 },
			{ name: 'typescript', pattern: /^typescriptImportFile\d* \?\? "typescript"/, count: 1 },
		];

		const computed = [...bundleText.matchAll(/\b(?:import|require)\(\s*(?!["'])([\s\S]{0,50})/g)]
			.map((match) => match[1])
			.filter((arg) => !arg.startsWith('import.meta'));

		const unaccepted = computed.filter((arg) => !accepted.some((entry) => entry.pattern.test(arg)));
		expect(unaccepted).toEqual([]);

		for (const entry of accepted) {
			expect(computed.filter((arg) => entry.pattern.test(arg))).toHaveLength(entry.count);
		}
	});

	it.skipIf(!bundleExists)('emits exactly the bundle and its wasm sibling, nothing else', () => {
		expect(readdirSync(runtimeDir).sort()).toEqual(['child-host.mjs', 'emscripten-module.wasm']);
	});

	it.skipIf(!bundleExists)(
		'runs under a runtime-dir-only read scope, resolving no node_modules',
		async () => {
			const result = await runBundleUnderRuntimeScope();
			expect(result).toEqual({ ok: true, value: { ok: true, amount: 7 } });
		},
		15000
	);
});
