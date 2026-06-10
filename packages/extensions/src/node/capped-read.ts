import { open } from 'node:fs/promises';

export type CappedReadResult =
	| { ok: true; text: string; bytes: number }
	| { ok: false; reason: 'too-large' | 'unreadable' };

/**
 * Reads a file as UTF-8 up to `maxBytes`, enforcing the cap during the read so a
 * file that grows after a stat is still bounded. Never buffers more than
 * `maxBytes` plus one probe byte, regardless of the file's size on disk.
 */
export async function readFileCapped(filePath: string, maxBytes: number): Promise<CappedReadResult> {
	// Fail closed on a bad cap. An invalid maxBytes (NaN, Infinity, non-integer)
	// would silently disable the bound, the one thing this primitive exists for.
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
		throw new Error('maxBytes must be a positive safe integer');
	}

	let handle;

	try {
		handle = await open(filePath, 'r');
	} catch {
		return { ok: false, reason: 'unreadable' };
	}

	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		let total = 0;

		while (total < buffer.length) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, null);
			if (bytesRead === 0) break;
			total += bytesRead;
		}

		if (total > maxBytes) return { ok: false, reason: 'too-large' };

		return { ok: true, text: buffer.toString('utf8', 0, total), bytes: total };
	} catch {
		return { ok: false, reason: 'unreadable' };
	} finally {
		await handle.close();
	}
}
