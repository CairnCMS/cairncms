import { describe, expect, it } from 'vitest';
import { createFrameReader, encodeFrame, writeFrame } from './transport.js';

function makeReader(maxFrameBytes = 1024 * 1024) {
	const frames: unknown[] = [];
	const violations: string[] = [];

	const read = createFrameReader({
		maxFrameBytes,
		onFrame: (value) => frames.push(value),
		onProtocolViolation: (reason) => violations.push(reason),
	});

	return { frames, violations, read };
}

function header(length: number): Buffer {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32BE(length, 0);
	return buffer;
}

describe('framed transport', () => {
	it('round-trips a value through encode and the reader', () => {
		const { frames, read } = makeReader();
		read(encodeFrame({ type: 'job', n: 42, s: 'hello' }));
		expect(frames).toEqual([{ type: 'job', n: 42, s: 'hello' }]);
	});

	it('rejects an over-cap header without buffering the body, even with body bytes in the same chunk', () => {
		const { frames, violations, read } = makeReader(1024);

		// Header claims 64MB with an 8MB body slice in the same chunk. The offset reader
		// reads only the 4-byte header and rejects, never copying the body that follows.
		read(Buffer.concat([header(64 * 1024 * 1024), Buffer.alloc(8 * 1024 * 1024)]));

		expect(frames).toEqual([]);
		expect(violations).toEqual(['frame exceeds the maximum size']);

		// After the violation the reader ignores all input, including a valid frame.
		read(encodeFrame({ ok: true }));
		expect(frames).toEqual([]);
		expect(violations).toHaveLength(1);
	});

	it('rejects an over-cap header that completes after a partial header, without buffering the body', () => {
		const { frames, violations, read } = makeReader(1024);
		const over = header(64 * 1024 * 1024);

		// The header arrives split: two bytes, then the remaining two bytes followed by
		// a large body in one chunk. The reader completes only the header and rejects,
		// it does not concat the body chunk.
		read(over.subarray(0, 2));
		read(Buffer.concat([over.subarray(2), Buffer.alloc(8 * 1024 * 1024)]));

		expect(frames).toEqual([]);
		expect(violations).toEqual(['frame exceeds the maximum size']);
	});

	it('fails closed on an invalid maxFrameBytes', () => {
		const noop = () => undefined;
		const options = (maxFrameBytes: number) => ({ maxFrameBytes, onFrame: noop, onProtocolViolation: noop });

		expect(() => createFrameReader(options(Number.NaN))).toThrow();
		expect(() => createFrameReader(options(Number.POSITIVE_INFINITY))).toThrow();
		expect(() => createFrameReader(options(1.5))).toThrow();
		expect(() => createFrameReader(options(0))).toThrow();
		expect(() => createFrameReader(options(-1))).toThrow();
		expect(() => createFrameReader(options(1024))).not.toThrow();
	});

	it('treats a within-cap frame with an invalid body as a protocol violation, not a throw', () => {
		const { frames, violations, read } = makeReader();
		const body = Buffer.from('{not valid json', 'utf8');

		expect(() => read(Buffer.concat([header(body.length), body]))).not.toThrow();
		expect(frames).toEqual([]);
		expect(violations).toHaveLength(1);
	});

	it('decodes a 256KB body cleanly (the previously-crashing size)', () => {
		const { frames, read } = makeReader();
		const big = 'x'.repeat(256 * 1024);
		read(encodeFrame({ value: big }));

		expect(frames).toHaveLength(1);
		expect((frames[0] as { value: string }).value).toHaveLength(256 * 1024);
	});

	it('reassembles a frame split across chunks', () => {
		const { frames, read } = makeReader();
		const frame = encodeFrame({ msg: 'split' });

		read(frame.subarray(0, 3));
		read(frame.subarray(3, 6));
		read(frame.subarray(6));

		expect(frames).toEqual([{ msg: 'split' }]);
	});

	it('delivers two frames packed into one chunk', () => {
		const { frames, read } = makeReader();
		read(Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]));
		expect(frames).toEqual([{ a: 1 }, { b: 2 }]);
	});

	it('accepts a frame at exactly the maximum size and rejects one over it', () => {
		const value = { pad: 'y'.repeat(1000) };
		const size = Buffer.from(JSON.stringify(value), 'utf8').length;

		const ok = makeReader(size);
		ok.read(encodeFrame(value));
		expect(ok.frames).toEqual([value]);
		expect(ok.violations).toEqual([]);

		const tooBig = makeReader(size - 1);
		tooBig.read(encodeFrame(value));
		expect(tooBig.frames).toEqual([]);
		expect(tooBig.violations).toHaveLength(1);
	});

	it('treats a zero-length body as a protocol violation', () => {
		const { frames, violations, read } = makeReader();
		read(header(0));

		expect(frames).toEqual([]);
		expect(violations).toHaveLength(1);
	});

	it('writes an encoded frame and invokes onDrain after the write', () => {
		const chunks: Buffer[] = [];
		let drained = false;

		const stream = {
			write(chunk: Buffer, callback: () => void) {
				chunks.push(chunk);
				callback();
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		writeFrame(stream, { ok: true }, () => {
			drained = true;
		});

		expect(drained).toBe(true);

		const { frames, read } = makeReader();
		read(chunks[0]!);
		expect(frames).toEqual([{ ok: true }]);
	});
});
