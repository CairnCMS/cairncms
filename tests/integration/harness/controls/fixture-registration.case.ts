/* eslint-disable no-empty-pattern */
import { beforeEach, expect, test as base, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { initializeFixtures } from '../fixture-setup.mjs';

const mode = process.env['CONTROL_REGISTRATION'];
vi.setConfig({ testTimeout: 100, hookTimeout: 3000 });
if (mode !== 'missing') initializeFixtures();
if (mode === 'late') vi.setConfig({ hookTimeout: 4000 });

const test = base.extend<{ state: boolean; ready: void }>({
	state: [
		async ({}, use) => {
			await delay(300);
			await use(true);
		},
		{ scope: 'file' },
	],
	ready: [
		async ({ state }, use) => {
			expect(state).toBe(true);
			await use();
		},
		{ auto: mode === 'auto' },
	],
});

if (mode === 'hook')
	beforeEach<{ state: boolean }>(async ({ state }) => {
		expect(state).toBe(true);
	});

test('a setup deadline is independent of the short body deadline', ({ state }) => {
	expect(state).toBe(true);
});
