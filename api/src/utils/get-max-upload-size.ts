import env from '../env.js';
import { parseOptionalSize } from './parse-config.js';

/**
 * Resolve the per-file upload cap in bytes, or undefined when unset (no limit).
 *
 * Throws on a malformed `FILES_MAX_UPLOAD_SIZE` so a typo fails startup rather than silently
 * disabling the cap or shrinking it. Called at boot (createApp) so the API refuses to start on a
 * bad value, and per upload to read the resolved cap.
 */
export function getMaxUploadSize(): number | undefined {
	const result = parseOptionalSize(env['FILES_MAX_UPLOAD_SIZE'], {
		envVar: 'FILES_MAX_UPLOAD_SIZE',
		floor: 1,
		ceiling: Number.MAX_SAFE_INTEGER - 1,
	});

	if (result.ok === false) {
		throw new Error(result.error.message);
	}

	return result.value;
}
