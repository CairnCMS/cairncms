import cron from 'node-cron';
import { describe, expect, it } from 'vitest';

function matches(expression: string, date: Date): boolean {
	const task = cron.createTask(expression, () => undefined, { timezone: 'UTC' });

	try {
		return task.match(date);
	} finally {
		void task.destroy();
	}
}

function utc(year: number, monthIndex: number, day: number): Date {
	return new Date(Date.UTC(year, monthIndex, day, 0, 0, 0));
}

describe('CairnCMS cron dialect (node-cron 4 contract)', () => {
	it.each([
		'@yearly',
		'@annually',
		'@monthly',
		'@weekly',
		'@daily',
		'@midnight',
		'@hourly',
		'0 0 1 * ?',
		'0 0 * * ?',
		'0 0 * * */7',
	])('accepts the newly-supported form %j', (expression) => {
		expect(cron.validate(expression)).toBe(true);
	});

	it('rejects impossible dates that were valid-but-inert under the previous engine', () => {
		expect(cron.validate('0 0 31 2 *')).toBe(false);
	});

	it('phases stepped ranges from the range start, so 1-15/2 fires odd days', () => {
		expect(matches('0 0 1-15/2 * *', utc(2029, 0, 1))).toBe(true);
		expect(matches('0 0 1-15/2 * *', utc(2029, 0, 2))).toBe(false);
		expect(matches('0 0 1-15/2 * *', utc(2029, 0, 15))).toBe(true);
	});

	it('phases wildcard day-of-month steps, so */2 fires odd days not even days', () => {
		expect(matches('0 0 */2 * *', utc(2029, 0, 1))).toBe(true);
		expect(matches('0 0 */2 * *', utc(2029, 0, 2))).toBe(false);
		expect(matches('0 0 */2 * *', utc(2029, 0, 3))).toBe(true);
	});

	it('phases wildcard month steps, so */2 fires odd months not even months', () => {
		expect(matches('0 0 1 */2 *', utc(2029, 0, 1))).toBe(true);
		expect(matches('0 0 1 */2 *', utc(2029, 1, 1))).toBe(false);
		expect(matches('0 0 1 */2 *', utc(2029, 2, 1))).toBe(true);
	});

	it('treats a weekday range touching 7 as every day, so 0-7 matches the whole week', () => {
		for (let day = 7; day <= 13; day++) {
			expect(matches('0 0 * * 0-7', utc(2029, 0, day))).toBe(true);
		}
	});

	it('wraps reversed ranges, so fri-mon covers Fri Sat Sun Mon but not Tue or Wed', () => {
		expect(matches('0 0 * * fri-mon', utc(2029, 0, 5))).toBe(true);
		expect(matches('0 0 * * fri-mon', utc(2029, 0, 6))).toBe(true);
		expect(matches('0 0 * * fri-mon', utc(2029, 0, 7))).toBe(true);
		expect(matches('0 0 * * fri-mon', utc(2029, 0, 8))).toBe(true);
		expect(matches('0 0 * * fri-mon', utc(2029, 0, 9))).toBe(false);
		expect(matches('0 0 * * fri-mon', utc(2029, 0, 10))).toBe(false);
	});

	it('shifts W to the nearest weekday, so 15W lands off the 15th when it is a weekend', () => {
		expect(matches('0 0 15W * *', utc(2029, 8, 15))).toBe(false);
		expect(matches('0 0 15W * *', utc(2029, 8, 14))).toBe(true);
		expect(matches('0 0 15W * *', utc(2029, 3, 15))).toBe(false);
		expect(matches('0 0 15W * *', utc(2029, 3, 16))).toBe(true);
	});

	it('resolves L to the real last day of the month, distinct from a fixed 31', () => {
		expect(matches('0 0 L 2 *', utc(2029, 1, 28))).toBe(true);
		expect(matches('0 0 L 2 *', utc(2029, 1, 27))).toBe(false);
		expect(matches('0 0 L 2 *', utc(2028, 1, 29))).toBe(true);
	});

	it('honors # as the nth weekday, so 6#3 is the third Saturday only', () => {
		expect(matches('0 0 * * 6#3', utc(2029, 0, 20))).toBe(true);
		expect(matches('0 0 * * 6#3', utc(2029, 0, 6))).toBe(false);
	});

	it('intersects a restricted day-of-month and day-of-week, so 13 and Friday means Friday the 13th only', () => {
		expect(matches('0 0 13 * 5', utc(2026, 10, 13))).toBe(true);
		expect(matches('0 0 13 * 5', utc(2026, 0, 13))).toBe(false);
		expect(matches('0 0 13 * 5', utc(2026, 0, 16))).toBe(false);
	});

	it.each(['@daily', '0 0 * * ?', '0 0 * * */7'])('schedules the newly-valid form %j', (expression) => {
		const task = cron.createTask(expression, () => undefined, {});

		try {
			expect(task.getNextRuns(1)).toHaveLength(1);
		} finally {
			void task.destroy();
		}
	});
});
