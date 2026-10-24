import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Returns an event writer for the vendor's provisioning log. The identity fields
 * name what the events belong to, so database and container events never share a key.
 */
export const createRecorder =
	(directory, identity) =>
	(type, detail = {}) =>
		appendFile(
			join(directory, 'provisioning.jsonl'),
			JSON.stringify({
				type,
				...identity,
				worker: process.pid,
				monotonicNs: process.hrtime.bigint().toString(),
				...detail,
			}) + '\n'
		);
