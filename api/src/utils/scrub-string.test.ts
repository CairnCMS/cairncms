import { describe, expect, it } from 'vitest';
import { REDACT_TEXT } from '../constants.js';
import { redactionFallback, scrubString } from './scrub-string.js';

describe('scrubString', () => {
	it('replaces every occurrence in a single pass', () => {
		expect(scrubString('a sk_1 b sk_1 c', ['sk_1'])).toBe(`a ${REDACT_TEXT} b ${REDACT_TEXT} c`);
	});

	it('scrubs a longer secret before a secret it contains', () => {
		const scrubbed = scrubString('full sk_live_abc123 and bare abc123', ['abc123', 'sk_live_abc123']);

		expect(scrubbed).toBe(`full ${REDACT_TEXT} and bare ${REDACT_TEXT}`);
		expect(scrubbed).not.toContain('sk_live_');
	});

	it('collapses the string when a secret is a substring of the redaction marker', () => {
		for (const secret of ['redact', '-', REDACT_TEXT]) {
			const scrubbed = scrubString(`before ${secret} after`, [secret]);

			expect(scrubbed, secret).toBe('');
			expect(scrubbed.includes(secret), secret).toBe(false);
		}
	});

	it('collapses to the marker when a replacement boundary forms another secret', () => {
		const scrubbed = scrubString('SECRETxKEY', ['x', 'T--red']);

		expect(scrubbed).toBe(REDACT_TEXT);
		expect(scrubbed).not.toContain('T--red');
	});

	it('scrubs the percent-encoded form of a secret', () => {
		const scrubbed = scrubString('https://example.com/?key=secret%20code&x=1', ['secret code']);
		expect(scrubbed).toBe(`https://example.com/?key=${REDACT_TEXT}&x=1`);
	});

	it('scrubs the plus-encoded form of a secret', () => {
		const scrubbed = scrubString('https://example.com/?key=secret+code&x=1', ['secret code']);
		expect(scrubbed).toBe(`https://example.com/?key=${REDACT_TEXT}&x=1`);
	});

	it('scrubs lowercase percent escapes without touching literal case', () => {
		const secret = 'SK/live secret';

		const scrubbed = scrubString('a SK%2flive%20secret b SK%2flive+secret c sk%2flive%20secret', [secret]);

		expect(scrubbed).toBe(`a ${REDACT_TEXT} b ${REDACT_TEXT} c sk%2flive%20secret`);
	});

	it('scrubs the base64 form of a secret', () => {
		const secret = 'sk_live_real_secret_value';
		const scrubbed = scrubString(`stored as ${Buffer.from(secret).toString('base64')}`, [secret]);
		expect(scrubbed).toBe(`stored as ${REDACT_TEXT}`);
	});

	it('scrubs the JSON-escaped form of a secret', () => {
		const secret = 'sk"with\\quotes';
		const serialized = JSON.stringify({ value: `the key is ${secret}` });
		const scrubbed = scrubString(serialized, [secret]);

		expect(scrubbed).toBe(JSON.stringify({ value: `the key is ${REDACT_TEXT}` }));
		expect(JSON.parse(scrubbed)).toEqual({ value: `the key is ${REDACT_TEXT}` });
	});

	it('skips empty secrets', () => {
		expect(scrubString('abc', [''])).toBe('abc');
	});

	it('returns the value untouched when nothing matches', () => {
		expect(scrubString('plain value', [])).toBe('plain value');
		expect(scrubString('plain value', ['absent'])).toBe('plain value');
	});
});

describe('redactionFallback', () => {
	it('uses the marker when it contains no active secret', () => {
		expect(redactionFallback(['sk_live_real_secret_value'])).toBe(REDACT_TEXT);
		expect(redactionFallback([])).toBe(REDACT_TEXT);
		expect(redactionFallback([''])).toBe(REDACT_TEXT);
	});

	it('falls back to an empty string when the marker contains a secret', () => {
		expect(redactionFallback(['redact'])).toBe('');
		expect(redactionFallback(['-'])).toBe('');
	});
});
