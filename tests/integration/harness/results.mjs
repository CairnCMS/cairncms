import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function validateSelection(selection, allowEmpty = false) {
	if (!Array.isArray(selection) || (!selection.length && !allowEmpty)) throw new Error('Missing or empty selection');
	const ids = new Set();
	const identities = new Set();

	for (const test of selection) {
		if (!test || typeof test.id !== 'string' || typeof test.file !== 'string' || typeof test.name !== 'string')
			throw new Error('Malformed selected test identity');
		const identity = JSON.stringify([test.file, test.name, test.location]);
		if (ids.has(test.id) || identities.has(identity))
			throw new Error(`Duplicate test identity: ${test.file} > ${test.name}`);
		ids.add(test.id);
		identities.add(identity);
	}
}

export function accountExecution(selection, execution) {
	validateSelection(selection, true);
	if (!Array.isArray(execution)) throw new Error('Malformed execution report');
	const selected = new Map(selection.map((test) => [test.id, test]));
	const results = new Map();

	for (const test of execution) {
		const expected = selected.get(test?.id);
		if (!expected || expected.file !== test.file || expected.name !== test.name)
			throw new Error(`Unexpected execution identity: ${test?.id}`);
		if (results.has(test.id)) throw new Error(`Duplicate execution identity: ${test.id}`);
		if (!['passed', 'failed', 'skipped', 'pending'].includes(test.result?.state))
			throw new Error(`Invalid result state: ${test.id}`);
		results.set(test.id, test);
	}

	const failures = execution.filter((test) => test.result.state === 'failed');
	const blocked = execution.filter((test) => test.result.state !== 'failed' && test.meta?.integrationBlockedBy);

	const unexpectedSkips = execution.filter(
		(test) => test.result.state === 'skipped' && !test.meta?.integrationBlockedBy
	);

	const notRun = selection.filter((test) => !results.has(test.id) || results.get(test.id).result.state === 'pending');
	const passed = execution.filter((test) => test.result.state === 'passed').length;
	return {
		selected: selection.length,
		passed,
		failures,
		blocked,
		unexpectedSkips,
		notRun,
		complete: passed === selection.length && !blocked.length,
	};
}

// Process success alone is insufficient: the child must finish, write valid native
// results, and account for every selected case. Preserve its primary failure too.
export async function readVendorResult(directory, childExitCode, list = false, ci = false) {
	const evidenceErrors = [];

	const read = async (name) => {
		try {
			return JSON.parse(await readFile(join(directory, `${name}.json`), 'utf8'));
		} catch (error) {
			evidenceErrors.push(`Cannot read ${name}.json: ${error.message}`);
			return undefined;
		}
	};

	const outcome = await read('outcome');
	if (!outcome || !Number.isInteger(outcome.exitCode) || !Array.isArray(outcome.fileErrors))
		evidenceErrors.push('Missing or malformed outcome');
	if (outcome?.completed !== true) evidenceErrors.push('Runner did not record completion');
	if (outcome?.exitCode !== childExitCode) evidenceErrors.push('Process exit disagrees with recorded outcome');
	const selection = await read('selection');
	const excluded = await read('exclusions');

	let accounting = {
		selected: 0,
		passed: 0,
		failures: [],
		blocked: [],
		unexpectedSkips: [],
		notRun: [],
		complete: false,
	};

	try {
		validateSelection(selection, true);
		// Preserve what was selected even when provisioning prevents any execution report.
		accounting = { ...accounting, selected: selection.length, notRun: selection };
		if (!Array.isArray(excluded) || excluded.some((test) => typeof test.reason !== 'string' || !test.reason.trim()))
			throw new Error('Malformed exclusion report');
		validateSelection([...selection, ...excluded]);

		if (list) accounting = { ...accounting, selected: selection.length, complete: true };
		else {
			accounting = accountExecution(selection, await read('execution'));
			const native = await read('results');

			if (!native || typeof native.success !== 'boolean' || !Array.isArray(native.testResults))
				evidenceErrors.push('Missing or malformed native results');
			else if (!native.success) evidenceErrors.push('Native runner reported failure');
			else {
				const assertions = native.testResults.flatMap((file) => {
					if (typeof file.name !== 'string' || !Array.isArray(file.assertionResults))
						throw new Error('Malformed native file result');
					return file.assertionResults.map((assertion) => {
						if (!Array.isArray(assertion.ancestorTitles) || typeof assertion.title !== 'string')
							throw new Error('Malformed native case result');
						return {
							file: file.name,
							name: [...assertion.ancestorTitles, assertion.title].join(' > '),
							status: assertion.status,
							location: assertion.location,
						};
					});
				});

				const key = (test) => JSON.stringify([test.file, test.name, test.location]);
				const passed = new Set(assertions.filter((test) => test.status === 'passed').map(key));
				if (
					native.numTotalTests !== assertions.length ||
					native.numPassedTests !== accounting.passed ||
					passed.size !== accounting.passed
				)
					throw new Error('Native result counts disagree with execution');
				if (selection.some((test) => !passed.has(key(test))))
					throw new Error('Native results omit a selected passing case');
				const skipped = new Set(assertions.filter((test) => test.status === 'skipped').map(key));
				if (excluded.some((test) => !skipped.has(key(test))))
					throw new Error('Native results omit a declared vendor exclusion');
			}
		}
	} catch (error) {
		evidenceErrors.push(error.message);
	}

	if (!accounting.complete && !list) evidenceErrors.push('Selected tests did not all complete successfully');
	if (ci && (list || accounting.selected === 0 || accounting.passed === 0))
		evidenceErrors.push('CI requires executed passing cases for every vendor; listing or exclusions cannot satisfy it');

	const exitCode =
		childExitCode ||
		outcome?.exitCode ||
		(evidenceErrors.length || outcome?.cancelled || outcome?.infrastructureError || outcome?.fileErrors?.length
			? 1
			: 0);

	return { ...outcome, ...accounting, excluded: Array.isArray(excluded) ? excluded : [], evidenceErrors, exitCode };
}
