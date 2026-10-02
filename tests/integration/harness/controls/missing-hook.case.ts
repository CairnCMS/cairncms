import { afterEach } from 'vitest';
import { createIdentityTest } from '../../fixtures/identities';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const test = createIdentityTest({ hookFixtures: ['missing-hook-control'] });

for (let index = 0; index < 3; index++) {
	test(`dependent on missing hook ${index}`, ({ api }) => {
		throw new Error(`MISSING_HOOK_BODY_EXECUTED ${api.url}`);
	});
}

afterEach(async () => undefined);
