import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigProtectedRecordException } from '../../exceptions/config-protected-record.js';
import { ConfigSchemaSourceException } from '../../exceptions/config-schema-source.js';
import { DestructiveChangesRequiredException } from '../../exceptions/destructive-changes-required.js';
import type { ConfigManifest, ConfigPlan } from '../../types/config.js';
import { safeLogFragment } from '../safe-log-fragment.js';
import { planDeletions, planHasDeletions } from './plan-folds.js';
import { schemaProvenanceRefusal } from './schema-provenance.js';

type RunPreflightInput = {
	plan: ConfigPlan;
	manifest: ConfigManifest;
	dryRun: boolean;
	destructive: boolean;
	forceSchema: boolean;
	currentRelease: string;
	currentVendor: string;
	referencedFolderKeys: ReadonlySet<string>;
	declaredFolderKeys: ReadonlySet<string>;
	currentFolderKeys: ReadonlySet<string>;
};

/**
 * Requires a validated, normalized configuration, and runs before the first write. Deletion and protection
 * authorization apply only to a mutating run, so a dry run keeps previewing them.
 */
export function assertRunAllowed(input: RunPreflightInput): void {
	const sourceRefusal = schemaProvenanceRefusal(input.manifest, {
		forceSchema: input.forceSchema,
		currentRelease: input.currentRelease,
		currentVendor: input.currentVendor,
	});

	if (sourceRefusal !== undefined) throw new ConfigSchemaSourceException(sourceRefusal);

	if (!input.dryRun) {
		const protection = input.plan.protections[0];

		if (protection !== undefined) {
			throw new ConfigProtectedRecordException(protection.message, {
				protection: { code: protection.code },
				contributors: protection.contributors,
			});
		}

		if (!input.destructive && planHasDeletions(input.plan)) {
			throw new DestructiveChangesRequiredException(
				'The configuration plan contains deletions. Re-run with the destructive option to authorize them.',
				{ deletions: planDeletions(input.plan) }
			);
		}
	}

	for (const key of input.referencedFolderKeys) {
		if (input.currentFolderKeys.has(key) || input.declaredFolderKeys.has(key)) continue;

		throw new ConfigInvalidException(
			`The schema references folder "${safeLogFragment(
				key
			)}", which is neither present on the target nor declared in the configuration. Declare it under folders, or remove the reference.`
		);
	}
}
