import { once } from 'node:events';
import { expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('crashes the owned API', async ({ api }) => {
	const exited = once(api.child, 'exit');
	api.child.kill('SIGKILL');
	await exited;
	expect(false, 'CONTROL_API_CRASH').toBe(true);
});

test('must not execute against a dead API', () => {
	process.stdout.write('CONTROL_LATER_EXECUTED\n');
});
