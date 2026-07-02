import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createUploadSizeLimit } from './upload-size-limit.js';

function makeSource(total: number): Readable {
	let sent = 0;

	return new Readable({
		read() {
			if (sent >= total) return this.push(null);
			const n = Math.min(4, total - sent);
			sent += n;
			this.push(Buffer.alloc(n, 0x61));
		},
	});
}

async function drain(total: number, cap: number) {
	const source = makeSource(total);
	const limiter = createUploadSizeLimit(source, cap);
	let written = 0;

	await new Promise<void>((resolve, reject) => {
		limiter.on('data', (chunk: Buffer) => (written += chunk.length));
		limiter.on('end', resolve);
		limiter.on('error', reject);
	});

	return { written, truncated: limiter.truncated, sourceDestroyed: source.destroyed };
}

describe('createUploadSizeLimit', () => {
	it('passes a stream within the cap through unchanged', async () => {
		const result = await drain(8, 10);
		expect(result.written).toBe(8);
		expect(result.truncated).toBe(false);
	});

	it('allows a stream exactly at the cap', async () => {
		const result = await drain(10, 10);
		expect(result.written).toBe(10);
		expect(result.truncated).toBe(false);
	});

	it('bounds the forwarded bytes, flags truncation, and aborts the source past the cap', async () => {
		const result = await drain(100, 10);
		expect(result.written).toBe(10);
		expect(result.truncated).toBe(true);
		expect(result.sourceDestroyed).toBe(true);
	});
});
