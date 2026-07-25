import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { describe, expect, it } from 'vitest';
import { getAccountabilityForRole } from './get-accountability-for-role.js';
import { getSystemAccountability } from './get-system-accountability.js';

describe('getSystemAccountability', () => {
	it('returns the admin, null-user system shape', () => {
		expect(getSystemAccountability()).toEqual({
			user: null,
			role: null,
			admin: true,
			app: true,
			permissions: [],
		});
	});

	it('returns a fresh object and a fresh permissions array each call', () => {
		const first = getSystemAccountability();
		const second = getSystemAccountability();

		expect(first).not.toBe(second);
		expect(first.permissions).not.toBe(second.permissions);
	});
});

describe('getAccountabilityForRole', () => {
	it('resolves the system role to the system accountability shape', async () => {
		const context = { accountability: null, schema: {} as SchemaOverview, database: {} as Knex };

		const resolved = await getAccountabilityForRole('system', context);

		expect(resolved).toEqual(getSystemAccountability());
	});
});
