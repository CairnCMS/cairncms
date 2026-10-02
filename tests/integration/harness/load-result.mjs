import assert from 'node:assert/strict';

/** @param {{ status: number | null, signal: string | null, stdout: string, stderr: string }} result */
export function assertSuccessfulLoad(result) {
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.signal, null, result.stderr);
	const report = JSON.parse(result.stdout);
	assert(report && typeof report === 'object', 'Missing Autocannon result');

	const counts = {
		errors: report.errors,
		timeouts: report.timeouts,
		non2xx: report.non2xx,
		successful: report['2xx'],
		completed: report.requests?.total,
	};

	const detail = JSON.stringify(counts);
	for (const value of Object.values(counts)) assert(Number.isInteger(value) && value >= 0, detail);
	assert.equal(counts.errors, 0, detail);
	assert.equal(counts.timeouts, 0, detail);
	assert.equal(counts.non2xx, 0, detail);
	assert(counts.successful > 0, detail);
	assert.equal(counts.completed, counts.successful, detail);
	return report;
}
