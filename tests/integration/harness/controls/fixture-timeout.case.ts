/* eslint-disable no-empty-pattern */
import { expect, test as base, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeFixtures } from '../fixture-setup.mjs';

if (process.env['CONTROL_LONG_FIXTURE'] === 'true') vi.setConfig({ hookTimeout: 5000 });
initializeFixtures();

const test = base.extend<{ delayed: boolean }>({
	delayed: [
		async ({}, use) => {
			await delay(800);
			await use(true);
		},
		{ auto: true, scope: 'file' },
	],
});

test('uses the declared setup deadline', ({ delayed }) => {
	expect(delayed).toBe(true);
});
