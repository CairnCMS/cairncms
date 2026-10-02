import { defineConfig } from 'vitest/config';
import base from '../vitest.config';

// Controls have their own discovery set, including when invoked without a filter.
export default defineConfig({
	...base,
	test: { ...base.test, projects: undefined, include: ['harness/controls/**/*.case.ts'] },
});
