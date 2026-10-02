import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guard = require('../../blackbox/setup/assert-ci-selection.js');

test('blackbox CI rejects narrowed discovery even with one selected file', () => {
	assert.throws(() => guard([{ testFilePath: '/routes/auth/login.test.ts' }], 'true'), /full blackbox suite/);
});

test('blackbox permits full CI runs and local file selection', () => {
	assert.doesNotThrow(() => guard([], 'true'));
	assert.doesNotThrow(() => guard([{ testFilePath: '/routes/auth/login.test.ts' }], ''));
	assert.doesNotThrow(() => guard([{ testFilePath: '/routes/auth/login.test.ts' }], 'false'));
});

test('blackbox coordination paths do not depend on the checkout directory name', () => {
	const getTestFilePath = require('../../blackbox/setup/get-test-file-path.js');

	for (const root of ['/repos/cairncms/tests/blackbox', '/repos/cairncms-blackbox/tests/blackbox']) {
		assert.equal(getTestFilePath(`${root}/common/seed-database.test.ts`, root), '/common/seed-database.test.ts');
	}
});
