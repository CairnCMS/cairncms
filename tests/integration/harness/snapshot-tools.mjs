import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

export const snapshotHash = (value) =>
	createHash('sha256')
		.update(Buffer.isBuffer(value) ? value : JSON.stringify(value))
		.digest('hex');

export async function runSnapshotTool({ args, operation, input, signal, record }) {
	signal.throwIfAborted();
	const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], signal });

	const chunks = [];
	let failure;
	const errors = [];
	let force;
	child.stderr.on('data', (chunk) => errors.push(chunk));
	child.stdout.on('data', (chunk) => chunks.push(chunk));
	child.stdin.on('error', () => {});

	const abort = () => {
		force = setTimeout(() => child.kill('SIGKILL'), 5000);
	};

	signal.addEventListener('abort', abort, { once: true });

	const done = new Promise((resolve, reject) => {
		child.once('error', (error) => {
			failure = error;
		});

		child.once('close', (code, exitSignal) => {
			clearTimeout(force);
			signal.removeEventListener('abort', abort);

			void record('tool-closed', { operation, pid: child.pid, code, signal: exitSignal }).then(() => {
				if (failure || code !== 0 || signal.aborted)
					reject(
						new Error(
							`Snapshot ${operation} failed (exit=${code}, signal=${exitSignal}, cancelled=${signal.aborted}): ${
								failure?.message ?? ''
							}\n${Buffer.concat(errors).toString()}`
						)
					);
				else resolve(Buffer.concat(chunks));
			}, reject);
		});
	});

	child.stdin.end(input);
	const [, result] = await Promise.all([record('tool-started', { operation, pid: child.pid }), done]);
	return result;
}
