import { z } from 'zod';

/**
 * Machine-readable reasons the source scan attaches to explain why a candidate
 * cannot run as confined code: raw Node authority, dynamic code, the legacy SDK
 * runtime import, internal imports, source that is unreadable, oversized, or
 * missing, and local paths that escape the package root.
 */
export const EXTENSION_VALIDATION_REASON_CODES = [
	'uses-node-builtin',
	'uses-raw-env',
	'uses-raw-fs',
	'uses-raw-network',
	'uses-child-process',
	'uses-internal-cairncms-import',
	'uses-dynamic-require',
	'uses-dynamic-import',
	'source-unavailable',
	'source-too-large',
	'source-read-failed',
	'local-path-escapes-root',
	'uses-legacy-sdk-runtime-import',
	'uses-dynamic-code',
] as const;

export const ExtensionValidationReasonCodeSchema = z.enum(EXTENSION_VALIDATION_REASON_CODES);

export type ExtensionValidationReasonCode = (typeof EXTENSION_VALIDATION_REASON_CODES)[number];

export const ExtensionValidationReasonSchema = z
	.object({
		code: ExtensionValidationReasonCodeSchema,
		message: z.string().optional(),
	})
	.strict();

export type ExtensionValidationReason = z.infer<typeof ExtensionValidationReasonSchema>;
