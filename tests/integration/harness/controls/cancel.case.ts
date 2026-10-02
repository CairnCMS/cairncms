import { apiTest as test } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('waits for cancellation with a real API', async ({ api, signal }) => {
	process.stdout.write(`EXECUTION_READY ${api.url}\n`);
	await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
});
