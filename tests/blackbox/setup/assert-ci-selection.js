function assertFullCiSelection(only = require('./sequentialTests').list.only, ci = process.env.CI) {
	if (ci && ci !== 'false' && only.length > 0) {
		throw new Error('CI requires the full blackbox suite. Clear sequentialTests.list.only before running CI.');
	}
}

module.exports = assertFullCiSelection;

if (require.main === module) assertFullCiSelection();
