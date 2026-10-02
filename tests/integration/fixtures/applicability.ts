import { describe, inject } from 'vitest';
import { getCurrentSuite } from '@vitest/runner';
import { vendors } from '../harness/database-vendors.mjs';

declare module 'vitest' {
	export interface TaskMeta {
		integrationApplicability?: { vendors: string[]; reason: string };
	}
}

export function describeForVendors(name: string, supported: string[], reason: string, body: () => void) {
	if (!reason.trim() || !supported.length || supported.some((vendor) => !vendors.includes(vendor)))
		throw new Error('Vendor applicability requires known vendors and a specific reason');
	const current = inject('integration').vendor;

	describe.skipIf(!supported.includes(current))(name, () => {
		const suite = getCurrentSuite().suite;
		if (!suite) throw new Error('Vendor applicability must annotate a native suite');
		suite.meta.integrationApplicability = { vendors: supported, reason };
		body();
	});
}
