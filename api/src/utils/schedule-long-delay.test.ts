import cron from 'node-cron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('scheduleSynchronizedJob long-running behavior', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.resetModules();
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
	});

	it('fires exactly at each occurrence across more than 30 days', async () => {
		vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
		const { scheduleSynchronizedJob } = await import('./schedule.js');

		const rule = '0 12 * * *';
		const probe = cron.schedule(rule, () => undefined);
		const expected = probe.getNextRuns(35).map((date) => date.getTime());
		await probe.destroy();

		const fired: number[] = [];

		const job = scheduleSynchronizedJob('flow-daily', rule, (date) => {
			fired.push(date.getTime());
		});

		expect(job).not.toBeNull();

		await vi.advanceTimersByTimeAsync(expected[expected.length - 1]! - Date.now() + 1_000);
		await job!.stop();

		expect(expected.length).toBe(35);
		expect(fired).toEqual(expected);
	});
});
