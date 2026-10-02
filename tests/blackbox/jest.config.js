const { pathsToModuleNameMapper } = require('ts-jest');
const { compilerOptions } = require('./tsconfig');

require('./setup/assert-ci-selection')();

module.exports = {
	preset: 'ts-jest',
	verbose: true,
	globalSetup: './setup/setup.ts',
	globalTeardown: './setup/teardown.ts',
	modulePathIgnorePatterns: ['./setup/utils'],
	testSequencer: './setup/customSequencer.js',
	testEnvironment: './setup/customEnvironment.ts',
	moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
	testTimeout: 15000,
};
