import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { ConfigProtectedRecordException } from '../../exceptions/config-protected-record.js';
import { ConfigSchemaSourceException } from '../../exceptions/config-schema-source.js';
import { DestructiveChangesRequiredException } from '../../exceptions/destructive-changes-required.js';
import { InvalidPayloadException } from '../../exceptions/invalid-payload.js';
import type { ConfigManifest, ConfigPlan } from '../../types/config.js';
import type { SnapshotField } from '../../types/index.js';
import { validateFolderReferences } from '../folder-references.js';
import { replaceControlCharacters } from '../safe-log-fragment.js';
import { planDeletions, planHasDeletions } from './plan-folds.js';
import { schemaProvenanceRefusal } from './schema-provenance.js';

type RunValidityInput = {
	manifest: ConfigManifest;
	forceSchema: boolean;
	currentRelease: string;
	currentVendor: string;
	/** The reconciled desired schema fields, empty when schema is unmanaged. */
	schemaFields: SnapshotField[];
	/** Every folder key the schema may resolve to: present on the target, or declared and preparable. */
	availableFolderKeys: ReadonlyMap<string, string>;
};

/**
 * Validates the whole run before the first write and before the no-change return: the schema source version and
 * vendor, and every folder reference. Refuses a dry run too, on a validated and normalized configuration.
 */
export function assertRunValid(input: RunValidityInput): void {
	const sourceRefusal = schemaProvenanceRefusal(input.manifest, {
		forceSchema: input.forceSchema,
		currentRelease: input.currentRelease,
		currentVendor: input.currentVendor,
	});

	if (sourceRefusal !== undefined) throw new ConfigSchemaSourceException(sourceRefusal);

	try {
		validateFolderReferences(input.schemaFields, input.availableFolderKeys);
	} catch (error) {
		// The validator's message carries operator-supplied field names, so sanitize it at this config boundary.
		if (error instanceof InvalidPayloadException) {
			throw new ConfigInvalidException(replaceControlCharacters(error.message));
		}

		throw error;
	}
}

/**
 * Authorizes a mutating run after its plan has been shown: refuses a protected plan, or a deletion plan without the
 * destructive flag. A dry run previews both instead of calling this.
 */
export function assertMutationAuthorized(plan: ConfigPlan, destructive: boolean): void {
	const protection = plan.protections[0];

	if (protection !== undefined) {
		throw new ConfigProtectedRecordException(protection.message, {
			protection: { code: protection.code },
			contributors: protection.contributors,
		});
	}

	if (!destructive && planHasDeletions(plan)) {
		throw new DestructiveChangesRequiredException(
			'The configuration plan contains deletions. Re-run with the destructive option to authorize them.',
			{ deletions: planDeletions(plan) }
		);
	}
}
