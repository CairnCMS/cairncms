import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const coord = vi.hoisted(() => ({
	shouldRun: (async () => true) as (key: string) => Promise<boolean>,
}));

vi.mock('../schedule-coordination.js', () => {
	class ScheduleCoordinationError extends Error {
		scheduleId: string;
		occurrence: number;

		constructor(scheduleId: string, occurrence: number) {
			super('Schedule coordination failed');
			this.name = 'ScheduleCoordinationError';
			this.scheduleId = scheduleId;
			this.occurrence = occurrence;
		}
	}

	return {
		isCoordinationEnabled: () => true,
		createRunCoordinator: () => ({ shouldRun: (key: string) => coord.shouldRun(key) }),
		ScheduleCoordinationError,
	};
});

vi.mock('../logger.js', () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import cron from 'node-cron';
import logger from '../logger.js';
import { ScheduleCoordinationError } from '../schedule-coordination.js';
import { scheduleSynchronizedJob } from './schedule.js';

type FiredEvents = { skipped: Array<string | undefined>; failed: number; finished: number };

async function fireOneOccurrence(id: string, cb: () => void | Promise<void>): Promise<FiredEvents> {
	const job = scheduleSynchronizedJob(id, '* * * * * *', cb);
	const task = [...cron.getTasks().values()].find((entry) => entry.name === id)!;

	const events: FiredEvents = { skipped: [], failed: 0, finished: 0 };

	task.on('execution:skipped', (context) => {
		events.skipped.push(context.reason);
	});

	task.on('execution:failed', () => {
		events.failed += 1;
	});

	task.on('execution:finished', () => {
		events.finished += 1;
	});

	await vi.advanceTimersByTimeAsync(1_000);
	await job!.stop();

	return events;
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2029-01-01T00:00:00.500Z'));
	coord.shouldRun = async () => true;
	vi.mocked(logger.error).mockClear();
});

afterEach(() => {
	for (const task of cron.getTasks().values()) {
		void task.destroy();
	}

	vi.useRealTimers();
});

describe('scheduleSynchronizedJob coordinator integration (real node-cron)', () => {
	it('does not claim or run while the gate is disabled, then claims and runs once enabled', async () => {
		const cb = vi.fn();
		let claims = 0;

		coord.shouldRun = async () => {
			claims += 1;
			return true;
		};

		let enabled = false;
		const job = scheduleSynchronizedJob('flow-gate', '* * * * * *', cb, () => enabled);
		const task = [...cron.getTasks().values()].find((entry) => entry.name === 'flow-gate')!;

		const skipped: Array<string | undefined> = [];

		task.on('execution:skipped', (context) => {
			skipped.push(context.reason);
		});

		await vi.advanceTimersByTimeAsync(1_000);

		expect(claims).toBe(0);
		expect(cb).not.toHaveBeenCalled();
		expect(skipped).toContain('not-elected');
		expect(logger.error).not.toHaveBeenCalled();

		enabled = true;
		await vi.advanceTimersByTimeAsync(1_000);

		expect(claims).toBeGreaterThanOrEqual(1);
		expect(cb).toHaveBeenCalled();

		await job!.stop();
	});

	it('runs the callback and finishes when the coordinator admits the occurrence', async () => {
		const cb = vi.fn();
		coord.shouldRun = async () => true;

		const events = await fireOneOccurrence('flow-admit', cb);

		expect(cb).toHaveBeenCalled();
		expect(events).toMatchObject({ skipped: [], failed: 0, finished: 1 });
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('suppresses the callback as not-elected without logging when another replica wins', async () => {
		const cb = vi.fn();
		coord.shouldRun = async () => false;

		const events = await fireOneOccurrence('flow-lose', cb);

		expect(cb).not.toHaveBeenCalled();
		expect(events).toMatchObject({ skipped: ['not-elected'], failed: 0, finished: 0 });
		expect(logger.error).not.toHaveBeenCalled();
	});

	it('fails closed as coordinator-error with exactly one redacted log when the claim throws', async () => {
		const cb = vi.fn();

		coord.shouldRun = async (key: string) => {
			throw new ScheduleCoordinationError('flow-error', Date.parse(key.slice(-24)));
		};

		const events = await fireOneOccurrence('flow-error', cb);

		expect(cb).not.toHaveBeenCalled();
		expect(events).toMatchObject({ skipped: ['coordinator-error'], failed: 0, finished: 0 });
		expect(logger.error).toHaveBeenCalledOnce();
		const [fields, message] = vi.mocked(logger.error).mock.calls[0]!;
		expect(fields).toMatchObject({ scheduleId: 'flow-error' });
		expect(typeof (fields as { occurrence?: unknown }).occurrence).toBe('number');
		expect(message).toBe('Schedule coordination failed');
	});

	it('records execution:failed and a generic redacted log when an admitted callback rejects', async () => {
		coord.shouldRun = async () => true;
		const secret = Object.assign(new Error('AUTH_TOKEN=secret'), { occurrence: 42 });
		const cb = vi.fn().mockRejectedValue(secret);

		const events = await fireOneOccurrence('flow-cbfail', cb);

		expect(cb).toHaveBeenCalled();
		expect(events).toMatchObject({ skipped: [], failed: 1, finished: 0 });
		expect(logger.error).toHaveBeenCalledOnce();
		expect(logger.error).toHaveBeenCalledWith({ scheduleId: 'flow-cbfail' }, 'Scheduled task failed');
		expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('secret');
	});
});
