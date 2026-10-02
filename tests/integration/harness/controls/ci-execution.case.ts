import { expect, test } from 'vitest';
import { describeForVendors } from '../../fixtures/applicability';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

describeForVendors('execution control', ['sqlite3'], 'Control requires SQLite', () => {
	test('executes the selected case', () => expect(true).toBe(true));
});
