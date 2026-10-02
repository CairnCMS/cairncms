/* eslint-disable no-console */
import { inject, test } from 'vitest';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('vendor progression control', () => {
	const vendor = inject('integration').vendor;
	console.log(`WRAPPER_BODY_${vendor}`);
	if (vendor === 'sqlite3') throw new Error('CONTROL_FIRST_VENDOR_FAILURE');
});
