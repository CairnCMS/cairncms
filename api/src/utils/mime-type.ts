import { toArray } from '@cairncms/utils';
import { minimatch } from 'minimatch';
import env from '../env.js';

/**
 * Normalize a declared MIME type for allow-list matching and for storage: strip media-type
 * parameters (`image/jpeg; charset=utf-8` becomes `image/jpeg`), lowercase, and trim. An absent
 * or blank type resolves to `application/octet-stream` so allow/deny is deterministic.
 */
export function normalizeMimeType(raw: string | null | undefined): string {
	const type = (raw ?? '').split(';')[0]?.trim().toLowerCase();
	return type || 'application/octet-stream';
}

/**
 * Resolve a declared MIME type against `FILES_MIME_TYPE_ALLOW_LIST` (glob patterns via minimatch).
 * Returns the normalized type (callers store this, not the raw header) and whether it is allowed,
 * so the multipart and import paths share one decision while rejecting in their own style.
 */
export function resolveMimeType(raw: string | null | undefined): { mimeType: string; allowed: boolean } {
	const mimeType = normalizeMimeType(raw);
	const patterns = toArray(env['FILES_MIME_TYPE_ALLOW_LIST'] as string | string[]);

	const allowed = patterns.some((pattern) => {
		const trimmed = pattern.trim();
		return trimmed !== '' && minimatch(mimeType, trimmed);
	});

	return { mimeType, allowed };
}
