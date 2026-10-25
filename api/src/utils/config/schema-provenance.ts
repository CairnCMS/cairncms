import type { ConfigManifest } from '../../types/config.js';
import { safeLogFragment } from '../safe-log-fragment.js';

type SchemaProvenanceContext = {
	forceSchema: boolean;
	currentRelease: string;
	currentVendor: string;
};

/**
 * Requires a structurally validated manifest. The override waives the schema source-version and vendor compatibility
 * check only, not manifest validation.
 */
export function schemaProvenanceRefusal(
	manifest: ConfigManifest,
	context: SchemaProvenanceContext
): string | undefined {
	if (!manifest.resources.includes('schema')) return undefined;
	if (context.forceSchema) return undefined;

	const provenance = manifest.schema;

	if (provenance === undefined) {
		return 'This configuration manages schema but records no source CairnCMS version or database vendor. Use --force-schema to apply it.';
	}

	if (provenance.release !== context.currentRelease) {
		return `This schema was captured on CairnCMS ${safeLogFragment(provenance.release)}. This instance runs ${
			context.currentRelease
		}. Use --force-schema to override the version check.`;
	}

	if (provenance.vendor !== context.currentVendor) {
		return `This schema was captured on the ${safeLogFragment(provenance.vendor)} database. This instance uses ${
			context.currentVendor
		}. Use --force-schema to override the vendor check.`;
	}

	return undefined;
}
