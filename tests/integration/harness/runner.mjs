import { VitestTestRunner } from 'vitest/runners';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { registrationKey, validateFixtureSetup } from './fixture-registration.mjs';

export default class IntegrationRunner extends VitestTestRunner {
	async onBeforeRunSuite(suite) {
		// Vitest 3 can create workers for a later project after broadcasting cancellation.
		// Persist the stop across that boundary so skipped work cannot provision fixtures.
		if (existsSync(join(this.injectValue('integration').directory, 'cancelled'))) this.cancel('test-failure');
		await super.onBeforeRunSuite(suite);
	}

	onCollectStart(file) {
		super.onCollectStart(file);
		globalThis[registrationKey] = { file, config: this.config, initialized: false };
	}

	async importFile(filepath, source) {
		const result = await super.importFile(filepath, source);
		if (source === 'collect') validateFixtureSetup(globalThis[registrationKey]);
		return result;
	}

	onCollected() {
		validateFixtureSetup(globalThis[registrationKey]);
	}
}
