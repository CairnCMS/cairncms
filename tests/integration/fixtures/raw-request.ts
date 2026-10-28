import net from 'node:net';

export const ERROR_SINK_ENDPOINT = '/cairncms-extension-error-sink/throw';
export const ERROR_SINK_FAILURE = 'error-sink endpoint failure';

export interface RawResponse {
	status: number | null;
	raw: string;
}

/**
 * Sends a verbatim request target over a raw socket, which supertest and fetch cannot do because
 * they build the request line from a parsed URL.
 */
export function sendRawTarget(
	backendUrl: string,
	target: string,
	headers: Record<string, string> = {}
): Promise<RawResponse> {
	const { hostname, port } = new URL(backendUrl);

	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: hostname, port: Number(port) }, () => {
			const lines = [`GET ${target} HTTP/1.1`, `Host: ${hostname}:${port}`, 'Connection: close'];
			for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
			socket.write(`${lines.join('\r\n')}\r\n\r\n`);
		});

		let data = '';

		socket.setTimeout(10_000, () => {
			socket.destroy();
			reject(new Error(`Raw request timed out for target ${target}`));
		});

		socket.on('data', (chunk) => (data += chunk.toString('utf8')));
		socket.on('error', reject);

		socket.on('close', () => {
			const statusLine = data.split('\r\n')[0] ?? '';
			const match = statusLine.match(/^HTTP\/1\.1 (\d{3})/);
			resolve({ status: match ? Number(match[1]) : null, raw: data });
		});
	});
}

export function records(logs: string): Array<Record<string, any>> {
	const parsed: Array<Record<string, any>> = [];

	for (const line of logs.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;

		try {
			parsed.push(JSON.parse(trimmed));
		} catch {
			continue;
		}
	}

	return parsed;
}

export function hasRequestUrl(logs: string, url: string): boolean {
	return records(logs).some((record) => record['req']?.url === url);
}

/** Captured records at warning level or above, excluding the deliberate error-sink barrier records. */
export function unexpectedWarnings(logs: string): Array<Record<string, any>> {
	return records(logs).filter((record) => {
		if (typeof record['level'] !== 'number' || record['level'] < 40) return false;
		if (record['err']?.message?.includes(ERROR_SINK_FAILURE)) return false;
		if (record['req']?.url === ERROR_SINK_ENDPOINT) return false;
		return true;
	});
}
