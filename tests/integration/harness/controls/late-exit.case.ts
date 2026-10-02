import { once } from 'node:events';
import { apiTest as test } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('an API exit after the last request fails the owning file', async ({ api }) => {
	const exited = once(api.child, 'exit');
	api.child.kill('SIGKILL');
	await exited;
});
