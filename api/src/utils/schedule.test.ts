import { beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
	captured: undefined as ((context: { date: Date }) => Promise<void>) | undefined,
	capturedOptions: undefined as Record<string, unknown> | undefined,
	validateResult: true,
	coordinationEnabled: false,
	scheduleThrows: null as Error | null,
	destroy: vi.fn(),
}));

vi.mock('node-cron', () => ({
	default: {
		schedule: (
			_expression: string,
			func: (context: { date: Date }) => Promise<void>,
			options: Record<string, unknown>
		) => {
			if (hoisted.scheduleThrows) throw hoisted.scheduleThrows;
			hoisted.captured = func;
			hoisted.capturedOptions = options;
			return { destroy: hoisted.destroy, stop: vi.fn() };
		},
		validate: () => hoisted.validateResult,
	},
}));

vi.mock('../schedule-coordination.js', () => {
	class ScheduleCoordinationError extends Error {
		scheduleId: string;
		occurrence: number | undefined;

		constructor(scheduleId: string, occurrence?: number) {
			super('Schedule coordination failed');
			this.name = 'ScheduleCoordinationError';
			this.scheduleId = scheduleId;
			this.occurrence = occurrence;
		}
	}

	return {
		isCoordinationEnabled: () => hoisted.coordinationEnabled,
		createRunCoordinator: (id: string) => ({ scheduleFor: id }),
		ScheduleCoordinationError,
	};
});

vi.mock('../logger.js', () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import logger from '../logger.js';
import { ScheduleCoordinationError } from '../schedule-coordination.js';
import { scheduleSynchronizedJob } from './schedule.js';

type LoggerAdapter = { error: (message: unknown, err?: unknown) => void; warn: (message: unknown) => void };

function capturedAdapter(): LoggerAdapter {
	return hoisted.capturedOptions!['logger'] as LoggerAdapter;
}

beforeEach(() => {
	hoisted.captured = undefined;
	hoisted.capturedOptions = undefined;
	hoisted.validateResult = true;
	hoisted.coordinationEnabled = false;
	hoisted.scheduleThrows = null;
	hoisted.destroy.mockClear();
	vi.mocked(logger.error).mockClear();
	vi.mocked(logger.warn).mockClear();
});

describe('scheduleSynchronizedJob', () => {
	it('returns a job and schedules with the identity as the task name and a logger adapter', () => {
		const job = scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		expect(job).not.toBeNull();
		expect(hoisted.capturedOptions?.['name']).toBe('flow-1');
		expect(hoisted.capturedOptions?.['logger']).toBeDefined();
	});

	it('returns null and logs the identity without the rule for an invalid expression', () => {
		hoisted.validateResult = false;

		const job = scheduleSynchronizedJob('flow-1', 'nope', vi.fn());

		expect(job).toBeNull();
		expect(hoisted.captured).toBeUndefined();
		expect(logger.error).toHaveBeenCalledOnce();
		const [fields, message] = vi.mocked(logger.error).mock.calls[0]!;
		expect(fields).toEqual({ scheduleId: 'flow-1' });
		expect(message).not.toContain('nope');
	});

	it('passes the per-task coordinator and distributed flag when coordination is enabled', () => {
		hoisted.coordinationEnabled = true;

		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		expect(hoisted.capturedOptions?.['distributed']).toBe(true);
		expect(hoisted.capturedOptions?.['runCoordinator']).toEqual({ scheduleFor: 'flow-1' });
	});

	it('schedules directly with no coordinator when coordination is disabled', () => {
		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		expect(hoisted.capturedOptions?.['distributed']).toBeUndefined();
		expect(hoisted.capturedOptions?.['runCoordinator']).toBeUndefined();
	});

	it('runs the callback with the scheduled occurrence and does not catch its rejection', async () => {
		const cb = vi.fn();
		scheduleSynchronizedJob('flow-1', '* * * * *', cb);

		const occurrence = new Date(2_000);
		await hoisted.captured!({ date: occurrence });

		expect(cb).toHaveBeenCalledWith(occurrence);
		expect(logger.error).not.toHaveBeenCalled();

		const failing = vi.fn().mockRejectedValue(new Error('handler blew up'));
		scheduleSynchronizedJob('flow-2', '* * * * *', failing);
		await expect(hoisted.captured!({ date: occurrence })).rejects.toThrow('handler blew up');
	});

	it('logs a coordination failure as a redacted record with the occurrence and no error content', () => {
		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		capturedAdapter().error('Run coordinator failed', new ScheduleCoordinationError('flow-1', 5_000));

		expect(logger.error).toHaveBeenCalledOnce();

		expect(logger.error).toHaveBeenCalledWith(
			{ scheduleId: 'flow-1', occurrence: 5_000 },
			'Schedule coordination failed'
		);
	});

	it('logs a coordination failure with no occurrence as a bare identity record', () => {
		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		capturedAdapter().error('Run coordinator failed', new ScheduleCoordinationError('flow-1'));

		expect(logger.error).toHaveBeenCalledOnce();
		expect(logger.error).toHaveBeenCalledWith({ scheduleId: 'flow-1' }, 'Schedule coordination failed');
	});

	it('logs a task failure as a bounded identity record with no error content', () => {
		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		capturedAdapter().error(new Error('flow blew up carrying secret material'));

		expect(logger.error).toHaveBeenCalledOnce();
		expect(logger.error).toHaveBeenCalledWith({ scheduleId: 'flow-1' }, 'Scheduled task failed');
	});

	it('classifies a callback error carrying a numeric occurrence property as a task failure', () => {
		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		capturedAdapter().error(Object.assign(new Error('flow error'), { occurrence: 999 }));

		expect(logger.error).toHaveBeenCalledWith({ scheduleId: 'flow-1' }, 'Scheduled task failed');
	});

	it('never invokes an occurrence getter on a non-coordination error', () => {
		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		let getterCalled = false;
		const trap = new Error('flow error');

		Object.defineProperty(trap, 'occurrence', {
			get() {
				getterCalled = true;
				throw new Error('getter should not run');
			},
		});

		expect(() => capturedAdapter().error(trap)).not.toThrow();
		expect(getterCalled).toBe(false);
		expect(logger.error).toHaveBeenCalledWith({ scheduleId: 'flow-1' }, 'Scheduled task failed');
	});

	it('never forwards an error message, stack, or cause to the log sink', () => {
		scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());
		const adapter = capturedAdapter();

		const marker = 'SENSITIVE-TOKEN-9f3';
		const secret = new Error(`message ${marker}`);
		secret.stack = `stack ${marker}`;
		(secret as { cause?: unknown }).cause = new Error(`cause ${marker}`);

		adapter.error('Run coordinator failed', secret);
		adapter.error(secret);
		adapter.error('Run coordinator failed', new ScheduleCoordinationError('flow-1', 5_000));
		adapter.warn(`missed execution at ${marker}`);

		for (const call of [...vi.mocked(logger.error).mock.calls, ...vi.mocked(logger.warn).mock.calls]) {
			expect(call).not.toContain(secret);
			expect(JSON.stringify(call)).not.toContain(marker);
		}
	});

	it('propagates a non-parser synchronous engine throw unmodified', () => {
		hoisted.scheduleThrows = new Error('`distributed` requires a `name`');

		expect(() => scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn())).toThrow('`distributed` requires a `name`');
	});

	it('destroys the task on stop', async () => {
		const job = scheduleSynchronizedJob('flow-1', '* * * * *', vi.fn());

		await job!.stop();

		expect(hoisted.destroy).toHaveBeenCalledOnce();
	});
});
