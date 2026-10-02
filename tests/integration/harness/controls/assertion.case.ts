import { test, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('early assertion', () => {
	process.stdout.write(`ASSERTION_AT ${Date.now()}\n`);
	expect('EARLY_FAILURE_DETAIL').toBe('expected');
});

test('later independent test', async () => {
	process.stdout.write('LATER_STARTED\n');
	const release = process.env.CONTROL_RELEASE;
	while (release && !existsSync(release)) await setTimeout(25);
	process.stdout.write('LATER_FINISHED\n');
});
