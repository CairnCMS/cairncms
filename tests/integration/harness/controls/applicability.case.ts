import { test, expect } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

if (process.env.CONTROL_APPLICABILITY !== 'all-excluded')
	test('independent applicable case', () => {
		expect(1).toBe(1);
	});

describeForVendors(
	'existing server-vendor case',
	['postgres'],
	'Control: this scenario applies only to PostgreSQL',
	() => {
		test('first preserved case', () => {
			expect(1).toBe(1);
		});

		test('second preserved case', () => {
			expect(1).toBe(1);
		});

		if (process.env.CONTROL_APPLICABILITY === 'unapproved')
			test.skip('unapproved skip inside an applicable suite', () => {
				throw new Error('UNAPPROVED_BODY');
			});
	}
);
