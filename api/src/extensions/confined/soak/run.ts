import { writeFileSync } from 'node:fs';
import { assertHeapBounded, assertSoakClean, buildReport, runSoak } from './harness.js';

// The heavy, deliberate run: thousands of invocations with the capacity report and the heap
// growth bound, invoked by the test:soak script and the CI soak workflows. The bounded smoke
// in the unit suite stays the per-PR regression guard.
const DEFAULT_COUNT = 3000;
// Heap growth after GC, so a no-leak run stays small. Generous enough to absorb V8 noise,
// tight enough to catch a steady per-invocation leak across thousands of runs.
const DEFAULT_MAX_GROWTH_MB = 64;

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const count = readPositiveInt(args, '--count') ?? DEFAULT_COUNT;
	const maxGrowthMb = readPositiveInt(args, '--max-growth-mb') ?? DEFAULT_MAX_GROWTH_MB;
	const out = readString(args, '--out');

	const result = await runSoak({ count });
	const report = buildReport(result);

	process.stdout.write(`${report}\n`);
	if (out !== undefined) writeFileSync(out, `${report}\n`);

	assertSoakClean(result);
	assertHeapBounded(result, maxGrowthMb * 1024 * 1024);

	process.stdout.write('soak: PASS\n');
}

function readString(args: string[], flag: string): string | undefined {
	const index = args.indexOf(flag);
	return index !== -1 ? args[index + 1] : undefined;
}

function readPositiveInt(args: string[], flag: string): number | undefined {
	const value = readString(args, flag);
	if (value === undefined) return undefined;

	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);

	return parsed;
}

main().catch((error: unknown) => {
	process.stderr.write(`soak: FAIL ${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
