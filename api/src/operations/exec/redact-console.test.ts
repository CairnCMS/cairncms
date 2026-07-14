import { describe, expect, it } from 'vitest';
import { REDACT_TEXT } from '../../constants.js';
import { redactConsoleArgs } from './index.js';

const identity = (value: unknown) => value;

describe('redactConsoleArgs', () => {
	it('routes the argument through the supplied redactor', () => {
		const redact = (value: unknown) => (value === 'longsecretvalue123' ? REDACT_TEXT : value);

		expect(redactConsoleArgs(['longsecretvalue123'], redact)).toBe(REDACT_TEXT);
	});

	it('unpacks a single argument before redacting', () => {
		expect(redactConsoleArgs(['only'], identity)).toBe('only');
	});

	it('packs multiple arguments into an array before redacting', () => {
		expect(redactConsoleArgs(['first', 'second', 'third'], identity)).toEqual(['first', 'second', 'third']);
	});

	it('leaves benign arguments unchanged under an identity redactor', () => {
		expect(redactConsoleArgs(['routed-log'], identity)).toBe('routed-log');
	});
});
