import { describe, inject } from 'vitest';
import { getCurrentSuite } from '@vitest/runner';
import { expandVendors } from '../harness/database-vendors.mjs';

declare module 'vitest' {
	export interface TaskMeta {
		integrationApplicability?: { vendors: string[]; reason: string };
	}
}

export function describeForVendors(name: string, supported: string[], reason: string, body: () => void) {
	if (!reason.trim() || !supported.length)
		throw new Error('Vendor applicability requires known vendors and a specific reason');
	const vendors = expandVendors(supported);
	const current = inject('integration').vendor;

	describe.skipIf(!vendors.includes(current))(name, () => {
		const suite = getCurrentSuite().suite;
		if (!suite) throw new Error('Vendor applicability must annotate a native suite');
		suite.meta.integrationApplicability = { vendors, reason };
		body();
	});
}
