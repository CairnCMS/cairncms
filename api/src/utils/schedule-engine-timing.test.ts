import cron from 'node-cron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../schedule-coordination.js', () => ({
	isCoordinationEnabled: () => false,
	createRunCoordinator: () => ({ shouldRun: async () => true }),
	ScheduleCoordinationError: class ScheduleCoordinationError extends Error {},
}));

vi.mock('../logger.js', () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import logger from '../logger.js';
import { scheduleSynchronizedJob } from './schedule.js';

beforeEach(() => {
	vi.useFakeTimers();
	vi.mocked(logger.warn).mockClear();
});

afterEach(() => {
	for (const task of cron.getTasks().values()) void task.destroy();
	vi.useRealTimers();
});

describe('node-cron 4 missed-execution behavior through the wrapper', () => {
	it('runs the current occurrence once after a five-second stall and never replays the missed ones', async () => {
		vi.setSystemTime(new Date('2029-01-01T00:00:00.000Z'));

		const fired: number[] = [];

		const job = scheduleSynchronizedJob('flow-miss', '* * * * * *', (date) => {
			fired.push(date.getTime());
		});

		expect(job).not.toBeNull();

		vi.setSystemTime(new Date('2029-01-01T00:00:05.000Z'));
		await vi.advanceTimersByTimeAsync(1_000);

		await job!.stop();

		expect(fired).toEqual([new Date('2029-01-01T00:00:06.000Z').getTime()]);
	});

	it('logs every missed occurrence as a redacted warning carrying no date or rule', async () => {
		vi.setSystemTime(new Date('2029-01-01T00:00:00.000Z'));

		const job = scheduleSynchronizedJob('flow-miss', '* * * * * *', () => undefined);

		vi.setSystemTime(new Date('2029-01-01T00:00:05.000Z'));
		await vi.advanceTimersByTimeAsync(1_000);

		await job!.stop();

		const calls = vi.mocked(logger.warn).mock.calls;

		expect(calls).toHaveLength(5);

		for (const call of calls) {
			expect(call).toEqual([{ scheduleId: 'flow-miss' }, 'Scheduled task warning']);
		}

		expect(JSON.stringify(calls)).not.toContain('2029');
	});
});
