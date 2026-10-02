import { expect, test } from 'vitest';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('executes the prepared application artifact', async () => {
	const module = await import(new URL('../../../../api/dist/server.js', import.meta.url).href);
	expect(module.healthy).toBe(true);
});
