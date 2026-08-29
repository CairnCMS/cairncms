import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../schedule-coordination.js', () => ({
	isCoordinationEnabled: () => false,
	createRunCoordinator: () => ({ shouldRun: async () => true }),
	ScheduleCoordinationError: class ScheduleCoordinationError extends Error {},
}));

vi.mock('../logger.js', () => ({
	default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const savedTZ = process.env['TZ'];

beforeEach(() => {
	process.env['TZ'] = 'America/New_York';
	vi.resetModules();
	vi.useFakeTimers();
});

afterEach(async () => {
	const cron = (await import('node-cron')).default;
	for (const task of cron.getTasks().values()) void task.destroy();

	vi.useRealTimers();

	if (savedTZ === undefined) delete process.env['TZ'];
	else process.env['TZ'] = savedTZ;
});

async function firedBetween(id: string, rule: string, fromIso: string, toIso: string): Promise<string[]> {
	const { scheduleSynchronizedJob } = await import('./schedule.js');

	vi.setSystemTime(new Date(fromIso));

	const fired: string[] = [];
	const job = scheduleSynchronizedJob(id, rule, (date) => fired.push(date.toISOString()));

	await vi.advanceTimersByTimeAsync(new Date(toIso).getTime() - new Date(fromIso).getTime());
	await job!.stop();

	return fired;
}

describe('node-cron 4 DST execution for a daily schedule through the wrapper (server-local America/New_York)', () => {
	it('does not fire the occurrence that falls in the spring-forward gap', async () => {
		const fired = await firedBetween(
			'dst-spring',
			'30 2 * * *',
			'2026-03-07T12:00:00.000Z',
			'2026-03-10T07:00:00.000Z'
		);

		expect(fired).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z']);
		expect(fired.some((iso) => iso.startsWith('2026-03-08'))).toBe(false);
	});

	it('fires the repeated fall-back occurrence exactly once', async () => {
		const fired = await firedBetween('dst-fall', '30 1 * * *', '2026-10-31T12:00:00.000Z', '2026-11-02T07:00:00.000Z');

		expect(fired).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
		expect(fired.filter((iso) => iso.startsWith('2026-11-01'))).toHaveLength(1);
	});
});
