import { configDefaults, defineConfig } from 'vitest/config';

const shared = defineConfig({
	test: {
		include: ['**/*.test.ts'],
		runner: './harness/runner.mjs',
		// Keep worker SQL Date bindings consistent with bootstrap and API processes;
		// MySQL bindings must not inherit the workstation timezone.
		env: { TZ: 'UTC' },
		exclude: [...configDefaults.exclude, '.artifacts/**'],
		setupFiles: ['./harness/live-failures.mjs'],
		pool: 'forks',
		fileParallelism: false,
		maxWorkers: 1,
		minWorkers: 1,
		isolate: true,
		watch: false,
		retry: 0,
		testTimeout: 30_000,
		hookTimeout: 120_000,
		teardownTimeout: 15_000,
		allowOnly: false,
		passWithNoTests: false,
		includeTaskLocation: true,
		disableConsoleIntercept: true,
	},
});

export default defineConfig({
	test: {
		...shared.test,
		projects: [
			{
				test: {
					...shared.test,
					name: 'load',
					include: ['**/*.load.test.ts'],
					sequence: { groupOrder: 0 },
					poolOptions: { forks: { singleFork: true } },
				},
			},
			{
				test: {
					...shared.test,
					name: 'integration',
					exclude: [...configDefaults.exclude, '.artifacts/**', '**/*.load.test.ts'],
					sequence: { groupOrder: 1 },
				},
			},
		],
	},
});
