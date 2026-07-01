import { Transform, type Readable } from 'node:stream';

/**
 * Cap an upload stream at `cap` bytes. Past the cap it stops forwarding, flags itself `truncated`, ends
 * its output, and destroys the source so the rest is never downloaded (bounding the transfer, not just
 * the persisted size). uploadOne reads `truncated` the same way it reads the Busboy multipart flag. A
 * file of exactly `cap` bytes is allowed; only more than `cap` is truncated.
 */
export function createUploadSizeLimit(source: Readable, cap: number): Transform & { truncated: boolean } {
	let total = 0;

	const limiter = new Transform({
		transform(chunk: Buffer, _encoding, callback) {
			if (limiter.truncated) return callback();

			if (total + chunk.length <= cap) {
				total += chunk.length;
				return callback(null, chunk);
			}

			const remaining = cap - total;
			if (remaining > 0) this.push(chunk.subarray(0, remaining));
			total = cap;
			limiter.truncated = true;
			this.push(null);
			source.destroy();
			return callback();
		},
	}) as Transform & { truncated: boolean };

	limiter.truncated = false;

	// A download error must fail the upload, not hang the consumer, so forward it to the limiter.
	source.on('error', (err) => limiter.destroy(err));
	source.pipe(limiter);

	return limiter;
}
