import { beforeAll, test } from 'vitest';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

beforeAll(() => {
	throw new Error('CONTROL_SETUP_FAILURE');
});

test('blocked by setup', () => {
	throw new Error('TEST_BODY_MUST_NOT_RUN');
});
