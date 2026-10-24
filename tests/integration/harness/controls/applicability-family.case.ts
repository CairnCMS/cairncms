import { test, expect } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

describeForVendors(
	'family selector case',
	['postgres'],
	'Control: this scenario applies to every PostgreSQL lane',
	() => {
		test('runs on every PostgreSQL lane', () => {
			expect(1).toBe(1);
		});
	}
);
