/* eslint-disable no-console */
import { inspect } from 'node:util';

// The standard reporter defers error details until the final summary.
export class LiveFailures {
	constructor(vendor, onFailure) {
		this.vendor = vendor;
		this.onFailure = onFailure;
	}

	onTestModuleStart(module) {
		console.log(`[${this.vendor}] RUN ${module.moduleId}`);
	}

	onTestCaseResult(test) {
		if (test.result().state !== 'failed') return;
		this.onFailure?.();
		if (test.meta().integrationFailureReported) return;
		this.error(`${test.module.moduleId} > ${test.fullName}`, test.result().errors);
	}

	onTestModuleEnd(module) {
		if (module.errors().length) {
			this.onFailure?.();
			this.error(module.moduleId, module.errors());
		}
	}

	error(label, errors) {
		printFailure(this.vendor, label, errors);
	}
}

export function printFailure(vendor, label, errors) {
	console.error(`\n[${vendor}] FAILURE ${label}`);

	for (const error of errors ?? []) {
		console.error(error.stack || error.message || inspect(error));
		if (error.diff) console.error(error.diff);
	}
}
