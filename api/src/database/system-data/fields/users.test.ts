import { describe, expect, it } from 'vitest';
import { systemFieldRows } from './index.js';

describe('directus_users system fields (GHSA-mvv8-v4jj-g47j)', () => {
	it('marks external_identifier with the conceal special', () => {
		const field = systemFieldRows.find((f) => f.collection === 'directus_users' && f.field === 'external_identifier');

		expect(field).toBeDefined();
		expect(field?.special).toContain('conceal');
	});

	it('marks auth_data with the conceal special', () => {
		const field = systemFieldRows.find((f) => f.collection === 'directus_users' && f.field === 'auth_data');
		expect(field).toBeDefined();
		expect(field?.special).toContain('conceal');
	});
});
