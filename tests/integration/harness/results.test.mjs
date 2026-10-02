import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVendorResult } from './results.mjs';

const identity = {
	id: 'case-1',
	file: '/suite.test.ts',
	name: 'protects a boundary',
	location: { line: 10, column: 1 },
};

const complete = {
	selection: [identity],
	exclusions: [],
	execution: [{ ...identity, result: { state: 'passed' } }],
	results: {
		success: true,
		numTotalTests: 1,
		numPassedTests: 1,
		testResults: [
			{
				name: identity.file,
				assertionResults: [{ ancestorTitles: [], title: identity.name, status: 'passed', location: identity.location }],
			},
		],
	},
	outcome: { exitCode: 0, completed: true, fileErrors: [] },
};

async function exercise(mutate, code = 0, ci = false, list = false) {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-results-'));

	try {
		const reports = structuredClone(complete);
		mutate(reports);
		for (const [name, report] of Object.entries(reports))
			await writeFile(join(directory, `${name}.json`), typeof report === 'string' ? report : JSON.stringify(report));
		return await readVendorResult(directory, code, list, ci);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

test('complete successful evidence is accepted', async () => {
	assert.equal((await exercise(() => {})).exitCode, 0);
});

for (const ci of [false, true])
	test(`complete exclusions-only evidence ${ci ? 'fails in CI' : 'is non-applicable locally'}`, async () => {
		const result = await exercise(
			(reports) => {
				reports.selection = [];
				reports.execution = [];
				reports.exclusions = [{ ...identity, reason: 'Existing vendor exclusion' }];
				reports.results.numPassedTests = 0;
				reports.results.testResults[0].assertionResults[0].status = 'skipped';
			},
			0,
			ci
		);

		assert.equal(result.exitCode, ci ? 1 : 0);
		if (ci) assert(result.evidenceErrors.some((error) => error.includes('CI requires executed passing cases')));
	});

test('listing evidence cannot satisfy CI execution', async () => {
	const result = await exercise(() => {}, 0, true, true);
	assert.equal(result.exitCode, 1);
	assert(result.evidenceErrors.some((error) => error.includes('CI requires executed passing cases')));
});

for (const name of ['selection', 'execution', 'results', 'outcome', 'exclusions']) {
	for (const damage of ['missing', 'truncated']) {
		test(`zero exit cannot hide ${damage} ${name}`, async () => {
			const result = await exercise((reports) => {
				if (damage === 'missing') delete reports[name];
				else reports[name] = '{';
			});

			assert.equal(result.exitCode, 1);
			assert(result.evidenceErrors.length);
		});
	}
}

for (const [name, mutate] of [
	[
		'empty native test list',
		(reports) => {
			reports.results.testResults = [];
		},
	],
	[
		'native totals disagree with cases',
		(reports) => {
			reports.results.numTotalTests = 2;
		},
	],
	[
		'native identities disagree with execution',
		(reports) => {
			reports.results.testResults[0].assertionResults[0].title = 'other case';
		},
	],
	[
		'empty selection',
		(reports) => {
			reports.selection = [];
		},
	],
	[
		'duplicate selected ID',
		(reports) => {
			reports.selection.push({ ...identity, name: 'different name' });
		},
	],
	[
		'ambiguous selected identity',
		(reports) => {
			reports.selection.push({ ...identity, id: 'case-2' });
		},
	],
	[
		'duplicate result',
		(reports) => {
			reports.execution.push(reports.execution[0]);
		},
	],
	[
		'unselected result',
		(reports) => {
			reports.execution.push({ ...reports.execution[0], id: 'other' });
		},
	],
	[
		'changed identity between collection and execution',
		(reports) => {
			reports.execution[0].name = 'another case';
		},
	],
	[
		'missing selected result',
		(reports) => {
			reports.execution = [];
		},
	],
	[
		'pending selected case',
		(reports) => {
			reports.execution[0].result.state = 'pending';
		},
	],
	[
		'unexpected dynamic skip',
		(reports) => {
			reports.execution[0].result.state = 'skipped';
		},
	],
	[
		'blocked prerequisite',
		(reports) => {
			reports.execution[0].result.state = 'skipped';
			reports.execution[0].meta = { integrationBlockedBy: 'schema' };
		},
	],
	[
		'failure after last request',
		(reports) => {
			reports.outcome.fileErrors = [{ file: identity.file, errors: [{ message: 'teardown failed' }] }];
		},
	],
	[
		'native runner failure',
		(reports) => {
			reports.results.success = false;
		},
	],
	[
		'missing completion marker',
		(reports) => {
			delete reports.outcome.completed;
		},
	],
	[
		'cancelled run',
		(reports) => {
			reports.outcome.cancelled = true;
		},
	],
]) {
	test(`zero exit cannot hide ${name}`, async () => {
		assert.equal((await exercise(mutate)).exitCode, 1);
	});
}

test('primary error survives a damaged report and abnormal process exit', async () => {
	const result = await exercise((reports) => {
		reports.outcome.infrastructureError = 'PRIMARY_SETUP_ERROR';
		delete reports.execution;
	}, 137);

	assert.equal(result.exitCode, 137);
	assert.equal(result.infrastructureError, 'PRIMARY_SETUP_ERROR');
	assert.equal(result.selected, 1);
	assert.deepEqual(result.notRun, [identity]);
	assert.equal(result.complete, false);
	assert(result.evidenceErrors.some((error) => error.includes('execution.json')));
});
