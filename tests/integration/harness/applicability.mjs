import { vendors } from './database-vendors.mjs';

export function exclusionReason(test, vendor) {
	let suite = test.parent;
	let reason;

	while (suite) {
		const applicability = suite.meta().integrationApplicability;

		if (applicability) {
			if (
				!Array.isArray(applicability.vendors) ||
				!applicability.vendors.length ||
				applicability.vendors.some((value) => !vendors.includes(value)) ||
				typeof applicability.reason !== 'string' ||
				!applicability.reason.trim()
			)
				throw new Error(`Malformed vendor applicability: ${test.fullName}`);
			if (!applicability.vendors.includes(vendor)) reason ??= applicability.reason;
		}

		suite = suite.parent;
	}

	if (reason && test.options.mode !== 'skip')
		throw new Error(`Excluded case is unexpectedly runnable: ${test.fullName}`);
	return reason;
}
