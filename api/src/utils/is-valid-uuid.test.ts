import { describe, expect, it } from 'vitest';
import { isValidUuid } from './is-valid-uuid.js';

describe('isValidUuid', () => {
	it('accepts a standard v4 UUID', () => {
		expect(isValidUuid('e22f209d-9e85-4ef5-b1fe-7dc09d2b67cf')).toBe(true);
	});

	it('accepts the nil UUID (all zeros)', () => {
		expect(isValidUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
	});

	it('accepts uppercase UUIDs', () => {
		expect(isValidUuid('E22F209D-9E85-4EF5-B1FE-7DC09D2B67CF')).toBe(true);
	});

	it('accepts UUIDs with arbitrary version bits (v6, v7, v8)', () => {
		expect(isValidUuid('e22f209d-9e85-6ef5-b1fe-7dc09d2b67cf')).toBe(true);
		expect(isValidUuid('e22f209d-9e85-7ef5-b1fe-7dc09d2b67cf')).toBe(true);
		expect(isValidUuid('e22f209d-9e85-8ef5-b1fe-7dc09d2b67cf')).toBe(true);
	});

	it('rejects malformed strings', () => {
		expect(isValidUuid('not-a-uuid')).toBe(false);
		expect(isValidUuid('fakeuuid-62d9-434d-a7c7-878c8376782e')).toBe(false);
		expect(isValidUuid('')).toBe(false);
	});

	it('rejects UUIDs with non-hex characters', () => {
		expect(isValidUuid('zzzzzzzz-0000-0000-0000-000000000000')).toBe(false);
	});

	it('rejects UUIDs with wrong segment lengths', () => {
		expect(isValidUuid('0000-0000-0000-0000-000000000000')).toBe(false);
		expect(isValidUuid('000000000-0000-0000-0000-000000000000')).toBe(false);
	});

	it('rejects UUIDs missing dashes', () => {
		expect(isValidUuid('00000000000000000000000000000000')).toBe(false);
	});
});
