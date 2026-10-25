import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	buildHardenedSpawn,
	generateScopeUnit,
	resolveHardeningPosture,
	type HardenedSpawn,
	type HardenedSpawnSpec,
} from './sandbox-hardening.js';

const PROBE_TIMEOUT_MS = 10_000;

const PROBE_SOURCE = `
import cp from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const results = {};

const attempt = (name, operation) => {
	try {
		operation();
		results[name] = 'allowed';
	} catch (error) {
		results[name] = error.code ?? String(error);
	}
};

attempt('readInsideRuntimeDir', () => fs.readFileSync(join(here, 'probe.mjs')));
attempt('readOutsideRuntimeDir', () => fs.readFileSync(process.execPath));
attempt('writeFile', () => fs.writeFileSync(join(here, 'written.txt'), ''));
attempt('childProcess', () => cp.execFileSync(process.execPath, ['--version']));
attempt('worker', () => new Worker('0', { eval: true }));
attempt('nativeAddon', () => process.dlopen({ exports: {} }, join(here, 'addon.node')));

process.stdout.write(JSON.stringify(results));
`;

function runProbe(spawned: HardenedSpawn): Promise<Record<string, string>> {
	return new Promise((resolve, reject) => {
		const child = spawn(spawned.command, spawned.args, { env: spawned.env, stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill('SIGKILL');
		}, PROBE_TIMEOUT_MS);

		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));

		child.on('error', (error) => {
			clearTimeout(timer);
			reject(error);
		});

		child.on('close', (code, signal) => {
			clearTimeout(timer);

			if (timedOut || code !== 0 || signal !== null) {
				const reason = timedOut
					? `timed out after ${PROBE_TIMEOUT_MS}ms`
					: `exited with code ${code}, signal ${signal}`;

				reject(new Error(`probe ${reason}: ${stderr.slice(0, 500)}`));
				return;
			}

			try {
				resolve(JSON.parse(stdout));
			} catch {
				reject(new Error(`probe produced no result: ${stderr.slice(0, 500)}`));
			}
		});
	});
}

describe('hardened spawn under the permission model', () => {
	let runtimeDir: string;

	beforeAll(() => {
		runtimeDir = mkdtempSync(join(tmpdir(), 'cairn-hardened-spawn-'));
		writeFileSync(join(runtimeDir, 'probe.mjs'), PROBE_SOURCE);
		writeFileSync(join(runtimeDir, 'addon.node'), '');
	});

	afterAll(() => {
		rmSync(runtimeDir, { recursive: true, force: true });
	});

	it('denies reads outside the runtime directory, writes, child processes, workers, and native addons', async () => {
		// The posture is built rather than detected, so a runtime that loses the Permission
		// Model fails this test instead of skipping it.
		const resolution = resolveHardeningPosture(
			{},
			{ networkNamespace: false, permissionModel: true, cgroupMemory: null }
		);

		if (!resolution.ok) throw new Error(resolution.error.message);
		expect(resolution.posture.applied).toEqual(['permission-model']);

		const spec: HardenedSpawnSpec = {
			execPath: process.execPath,
			childExecArgv: [],
			childPath: join(runtimeDir, 'probe.mjs'),
			runtimeDir,
			isBundled: true,
			memoryMaxBytes: 64 * 1024 * 1024,
			scopeUnit: generateScopeUnit(),
			childEnv: { PATH: process.env['PATH'] },
			busEnv: {},
		};

		const spawned = buildHardenedSpawn(resolution.posture, spec);
		expect(spawned.args).toEqual(['--permission', `--allow-fs-read=${runtimeDir}`, spec.childPath]);

		await expect(runProbe(spawned)).resolves.toEqual({
			readInsideRuntimeDir: 'allowed',
			readOutsideRuntimeDir: 'ERR_ACCESS_DENIED',
			writeFile: 'ERR_ACCESS_DENIED',
			childProcess: 'ERR_ACCESS_DENIED',
			worker: 'ERR_ACCESS_DENIED',
			nativeAddon: 'ERR_DLOPEN_DISABLED',
		});
	}, 15_000);
});
