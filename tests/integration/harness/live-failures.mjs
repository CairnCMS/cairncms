import { afterEach, inject } from 'vitest';
import { getNames } from '@vitest/runner/utils';
import { printFailure } from './reporter.mjs';

// Vitest 3's throttled worker-to-reporter updates can stall at the 100ms boundary.
// Register after fixtures/body so this setup-file hook cannot impose its earlier
// default timeout on a file that declares a longer fixture setup limit.
// The public failure hook writes directly after test hooks, independently of that queue.
afterEach(({ task, onTestFailed }) => {
	onTestFailed(() => {
		printFailure(
			inject('integration').vendor,
			`${task.file.filepath} > ${getNames(task).slice(1).join(' > ')}`,
			task.result?.errors
		);

		task.meta.integrationFailureReported = true;
	});
});
