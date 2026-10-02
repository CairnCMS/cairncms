/**
 * Capture one already-owned CLI child. Interactive callers keep stdin open;
 * both forms have the same bounded lifetime and wait for actual process exit.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{stop: (child: import('node:child_process').ChildProcess) => Promise<void>, timeoutMs?: number, diagnostics?: string}} options
 */
export function ownCli(child, { stop, timeoutMs = 25_000, diagnostics = '' }) {
	let stdout = '';
	let stderr = '';
	let timedOut = false;
	/** @type {NodeJS.ErrnoException | undefined} */
	let inputError;
	child.stdout.setEncoding('utf8');
	child.stderr.setEncoding('utf8');

	const captureOut = (chunk) => {
		stdout += chunk;
	};

	const captureErr = (chunk) => {
		stderr += chunk;
	};

	const captureInputError = (error) => {
		// Argument rejection can close the pipe before supplied input is consumed.
		if (!['EPIPE', 'ECONNRESET'].includes(error.code)) inputError = error;
	};

	child.stdout.on('data', captureOut);
	child.stderr.on('data', captureErr);
	child.stdin.on('error', captureInputError);

	const timer = setTimeout(() => {
		timedOut = true;
		void stop(child);
	}, timeoutMs);

	const result = (async () => {
		try {
			const status = await new Promise((resolve, reject) => {
				child.once('error', reject);

				child.once('close', (status, signal) => {
					child.off('error', reject);
					resolve({ status, signal });
				});
			});

			if (timedOut) throw new Error(`CLI exceeded ${timeoutMs}ms${diagnostics ? `; see ${diagnostics}` : ''}`);
			if (inputError) throw inputError;
			return { ...status, stdout, stderr };
		} finally {
			clearTimeout(timer);
			await stop(child);
			child.stdout.off('data', captureOut);
			child.stderr.off('data', captureErr);
			child.stdin.off('error', captureInputError);
		}
	})();

	// A caller may be waiting for a prompt when the child fails. Keep the
	// rejection available to await without creating an unhandled rejection.
	void result.catch(() => {});
	return { child, result, output: () => stdout + stderr };
}
