import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

/** Grab an unused TCP port by opening an ephemeral listener and releasing it. */
export async function pickUnusedPort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);

		server.listen(0, () => {
			const address = server.address();

			if (typeof address === 'object' && address !== null) {
				const port = address.port;
				server.close(() => resolve(port));
			} else {
				server.close(() => reject(new Error('Failed to acquire port')));
			}
		});
	});
}

/**
 * Run `pnpm --filter api run cli bootstrap` with the given env.
 * Waits for the process to exit (bootstrap is synchronous: runs migrations,
 * creates first admin user, exits).
 */
export async function runBootstrap(env: NodeJS.ProcessEnv, repoRoot: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn('pnpm', ['--filter', 'api', 'run', 'cli', 'bootstrap'], {
			env,
			cwd: repoRoot,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		let stderr = '';

		proc.stderr?.on('data', (chunk) => {
			stderr += chunk.toString();
		});

		proc.on('error', reject);

		proc.on('exit', (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`bootstrap failed with exit code ${code}\n${stderr}`));
			}
		});
	});
}

export interface ApiHandle {
	kill(): Promise<void>;
}

/**
 * Spawn the API subprocess (via `pnpm --filter api run dev` minus the watcher —
 * we invoke tsx directly via pnpm so we don't need a prior build).
 */
export function spawnApi(env: NodeJS.ProcessEnv, repoRoot: string): ApiHandle {
	const proc: ChildProcess = spawn('pnpm', ['--filter', 'api', 'exec', 'tsx', 'src/start.ts'], {
		env,
		cwd: repoRoot,
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	// Surface API output on debug; silent by default.
	if (process.env['SDK_IT_DEBUG'] === '1') {
		proc.stdout?.on('data', (c) => process.stdout.write(`[api] ${c}`));
		proc.stderr?.on('data', (c) => process.stderr.write(`[api] ${c}`));
	}

	proc.on('exit', (code, signal) => {
		if (code !== null && code !== 0 && signal === null) {
			// Process crashed during test run — surface the exit code
			process.stderr.write(`[api] subprocess exited unexpectedly with code ${code}\n`);
		}
	});

	return {
		async kill() {
			if (proc.exitCode !== null) return;
			proc.kill('SIGTERM');

			// Wait up to 5s for clean exit, then SIGKILL
			const exited = await new Promise<boolean>((resolve) => {
				const timeout = setTimeout(() => resolve(false), 5000);

				proc.once('exit', () => {
					clearTimeout(timeout);
					resolve(true);
				});
			});

			if (!exited) proc.kill('SIGKILL');
		},
	};
}

/** Poll /server/ping until it returns 200 or we time out. */
export async function waitForReady(url: string, timeoutMs = 60_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown = null;

	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${url}/server/ping`);
			if (response.ok) return;
			lastError = new Error(`Got HTTP ${response.status}`);
		} catch (err) {
			lastError = err;
		}

		await new Promise((r) => setTimeout(r, 500));
	}

	throw new Error(`API not ready after ${timeoutMs}ms: ${lastError}`);
}
