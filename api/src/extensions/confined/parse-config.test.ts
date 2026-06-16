import { describe, expect, it } from 'vitest';
import { parseCount, parseDuration, parseSize, type BoundedSpec } from './parse-config.js';

const KiB = 1024;
const MiB = 1024 * 1024;

const SIZE: BoundedSpec = { envVar: 'X_SIZE', defaultValue: 1 * MiB, floor: 1 * KiB, ceiling: 16 * MiB };
const DURATION: BoundedSpec = { envVar: 'X_TIME', defaultValue: 10_000, floor: 1_000, ceiling: 300_000 };
const COUNT: BoundedSpec = { envVar: 'X_COUNT', defaultValue: 4, floor: 1, ceiling: 32 };

describe('parseSize', () => {
	it('returns the default when unset, null, or blank', () => {
		expect(parseSize(undefined, SIZE)).toEqual({ ok: true, value: 1 * MiB });
		expect(parseSize(null, SIZE)).toEqual({ ok: true, value: 1 * MiB });
		expect(parseSize('   ', SIZE)).toEqual({ ok: true, value: 1 * MiB });
	});

	it('parses human-readable sizes and bare byte integers', () => {
		expect(parseSize('16mb', SIZE)).toEqual({ ok: true, value: 16 * MiB });
		expect(parseSize('256kb', SIZE)).toEqual({ ok: true, value: 256 * KiB });
		expect(parseSize('16 MB', SIZE)).toEqual({ ok: true, value: 16 * MiB });
		expect(parseSize('2048', SIZE)).toEqual({ ok: true, value: 2048 });
	});

	it('accepts a number as bytes', () => {
		expect(parseSize(4096, SIZE)).toEqual({ ok: true, value: 4096 });
	});

	it('rejects lax, malformed, and wrong-type values', () => {
		for (const bad of ['1gib', '10bananas', '-5mb', '1.5mb', '1.5', true, 1.5, -5]) {
			const result = parseSize(bad, SIZE);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain('must be a size like "16mb"');
		}
	});

	it('enforces the floor and ceiling', () => {
		expect(parseSize('512b', SIZE).ok).toBe(false);
		expect(parseSize('32mb', SIZE).ok).toBe(false);
		const floor = parseSize('512b', SIZE);
		if (!floor.ok) expect(floor.error.message).toMatch(/at least 1KB/i);
	});
});

describe('parseDuration', () => {
	it('returns the default when unset or blank', () => {
		expect(parseDuration(undefined, DURATION)).toEqual({ ok: true, value: 10_000 });
		expect(parseDuration('', DURATION)).toEqual({ ok: true, value: 10_000 });
	});

	it('parses human-readable durations and a number of milliseconds', () => {
		expect(parseDuration('10s', DURATION)).toEqual({ ok: true, value: 10_000 });
		expect(parseDuration('2s', DURATION)).toEqual({ ok: true, value: 2_000 });
		expect(parseDuration(5_000, DURATION)).toEqual({ ok: true, value: 5_000 });
	});

	it('rejects malformed, negative, and wrong-type values', () => {
		for (const bad of ['garbage', '-5s', true, -1]) {
			const result = parseDuration(bad, DURATION);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain('must be a duration like "10s"');
		}
	});

	it('enforces the floor and ceiling', () => {
		expect(parseDuration('500ms', DURATION).ok).toBe(false);
		expect(parseDuration('10m', DURATION).ok).toBe(false);
	});
});

describe('parseCount', () => {
	it('returns the default when unset', () => {
		expect(parseCount(undefined, COUNT)).toEqual({ ok: true, value: 4 });
	});

	it('parses a whole number from a string or a number', () => {
		expect(parseCount('8', COUNT)).toEqual({ ok: true, value: 8 });
		expect(parseCount(8, COUNT)).toEqual({ ok: true, value: 8 });
	});

	it('rejects non-integers, non-numeric strings, and wrong types', () => {
		for (const bad of ['4.5', 'abc', true, 1.5, -1]) {
			const result = parseCount(bad, COUNT);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.message).toContain('must be a whole number');
		}
	});

	it('enforces the floor and ceiling', () => {
		expect(parseCount('0', COUNT).ok).toBe(false);
		expect(parseCount('64', COUNT).ok).toBe(false);
	});
});
