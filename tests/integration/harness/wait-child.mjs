import { StringDecoder } from 'node:string_decoder';

/** Wait for the production entry's IPC readiness or a successful bootstrap exit.
 * @param {import('node:child_process').ChildProcess} child
 * @param {{ready: boolean, phase?: string, diagnostics?: string, timeoutMs?: number}} options
 */
export function waitChild(child, { ready, phase = 'startup', diagnostics = '', timeoutMs = 90_000 }) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let stderr = '';
		const decoder = new StringDecoder('utf8');

		const capture = (chunk) => {
			stderr = (stderr + (typeof chunk === 'string' ? chunk : decoder.write(chunk))).slice(-16_384);
		};

		const finish = (error, value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.off('error', onError);
			child.off('close', onClose);
			child.off('message', onMessage);
			child.stderr?.off('data', capture);
			if (error) reject(error);
			else resolve(value);
		};

		const onError = (error) => finish(error);

		const onClose = (code, signal) => {
			if (!ready && code === 0) finish();
			else
				finish(
					new Error(
						`${phase} exited before ${
							ready ? 'readiness' : 'completion'
						} (code=${code} signal=${signal}); ${diagnostics}\n${stderr.trim() || 'no stderr'}`
					)
				);
		};

		const onMessage = (message) => {
			if (ready && message?.type === 'ready') finish(undefined, message);
		};

		const timer = setTimeout(
			() => finish(new Error(`${phase} exceeded ${timeoutMs}ms; ${diagnostics}\n${stderr}`)),
			timeoutMs
		);

		child.once('error', onError);
		child.once('close', onClose);
		child.on('message', onMessage);
		child.stderr?.on('data', capture);
		// A process can finish between launch and installing a readiness wait.
		if (child.exitCode !== null || child.signalCode !== null) onClose(child.exitCode, child.signalCode);
	});
}
