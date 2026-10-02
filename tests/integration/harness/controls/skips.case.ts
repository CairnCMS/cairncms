import { test, expect } from 'vitest';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('independent passing case', () => {
	expect(true).toBe(true);
});

if (process.env.CONTROL_SKIP === 'dynamic') {
	test('unexpected dynamic skip', ({ skip }) => {
		skip('unexpected');
	});
} else {
	test.skip('unexpected declared skip', () => {
		throw new Error('SKIPPED_BODY_MUST_NOT_RUN');
	});
}
