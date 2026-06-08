/** The length-prefixed framed transport (`[4-byte BE length][JSON body]`) replacing Node's fork IPC. */

const HEADER_BYTES = 4;

/** Encodes a value as a framed buffer: a 4-byte big-endian length, then the JSON body. */
export function encodeFrame(value: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(value), 'utf8');
	const header = Buffer.alloc(HEADER_BYTES);
	header.writeUInt32BE(body.length, 0);
	return Buffer.concat([header, body]);
}

export interface FrameReaderOptions {
	maxFrameBytes: number;
	onFrame: (value: unknown) => void;
	onProtocolViolation: (reason: string) => void;
}

/**
 * Creates a streaming reader that turns raw chunks into decoded frames. It assembles
 * the 4-byte length header before buffering any body, so a header over `maxFrameBytes`
 * is rejected without ever copying the oversized body. An over-cap header or a body
 * that fails to parse is a protocol violation: the reader reports it once and then
 * ignores all further input.
 */
export function createFrameReader(options: FrameReaderOptions): (chunk: Buffer) => void {
	const { maxFrameBytes, onFrame, onProtocolViolation } = options;

	// Fail closed on a bad cap. An invalid maxFrameBytes (NaN, Infinity, non-integer)
	// would silently disable the size check, the one thing this primitive exists for.
	if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1) {
		throw new Error('maxFrameBytes must be a positive safe integer');
	}

	const headerBuf = Buffer.alloc(HEADER_BYTES);
	let headerSeen = 0;
	let need = -1;
	let bodyChunks: Buffer[] = [];
	let bodyLen = 0;
	let violated = false;

	function violate(reason: string): void {
		violated = true;
		bodyChunks = [];
		bodyLen = 0;
		onProtocolViolation(reason);
	}

	return (chunk: Buffer): void => {
		if (violated) return;

		let offset = 0;

		while (offset < chunk.length) {
			if (need === -1) {
				const take = Math.min(HEADER_BYTES - headerSeen, chunk.length - offset);
				chunk.copy(headerBuf, headerSeen, offset, offset + take);
				headerSeen += take;
				offset += take;

				if (headerSeen < HEADER_BYTES) return;

				need = headerBuf.readUInt32BE(0);
				headerSeen = 0;

				if (need > maxFrameBytes) {
					violate('frame exceeds the maximum size');
					return;
				}
			}

			const take = Math.min(need - bodyLen, chunk.length - offset);

			if (take > 0) {
				bodyChunks.push(chunk.subarray(offset, offset + take));
				bodyLen += take;
				offset += take;
			}

			if (bodyLen < need) return;

			const body = bodyChunks.length === 1 ? bodyChunks[0]! : Buffer.concat(bodyChunks, bodyLen);
			bodyChunks = [];
			bodyLen = 0;
			need = -1;

			let value: unknown;

			try {
				value = JSON.parse(body.toString('utf8'));
			} catch {
				violate('frame body is not valid JSON');
				return;
			}

			onFrame(value);
		}
	};
}

/** Writes a framed value and invokes `onDrain` once the write flushes, so the writer can exit without truncating the frame. */
export function writeFrame(stream: NodeJS.WritableStream, value: unknown, onDrain: () => void): void {
	stream.write(encodeFrame(value), () => onDrain());
}
