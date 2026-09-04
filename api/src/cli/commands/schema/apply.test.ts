import chalk from 'chalk';
import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../../../logger.js';
import { apply } from './apply.js';

const { FIXTURE_DIFF } = vi.hoisted(() => {
	const kind = { NEW: 'N', DELETE: 'D', EDIT: 'E' };

	return {
		FIXTURE_DIFF: {
			collections: [
				{ collection: 'reviews', diff: [{ kind: kind.NEW, rhs: {} }] },
				{ collection: 'legacy', diff: [{ kind: kind.DELETE, lhs: {} }] },
			],
			fields: [
				{
					collection: 'articles',
					field: 'title',
					diff: [{ kind: kind.EDIT, path: ['articles', 'meta', 'note'], lhs: null, rhs: 'Reviewed' }],
				},
			],
			relations: [],
		},
	};
});

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	isInstalled: vi.fn(async () => true),
	validateDatabaseConnection: vi.fn(async () => undefined),
}));

vi.mock('../../../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../../../utils/get-snapshot.js', () => ({ getSnapshot: vi.fn(async () => ({})) }));

vi.mock('../../../utils/get-snapshot-diff.js', () => ({ getSnapshotDiff: vi.fn(() => FIXTURE_DIFF) }));

vi.mock('../../../utils/apply-snapshot.js', () => ({ applySnapshot: vi.fn(async () => undefined) }));

vi.mock('inquirer', () => ({ default: { prompt: vi.fn(async () => ({ proceed: false })) } }));

vi.mock('fs', () => ({ promises: { readFile: vi.fn(async () => '{}') } }));

function expectedPlan(): string {
	const inner =
		chalk.black.underline.bold('Collections:') +
		`\n  - ${chalk.green('Create')} reviews` +
		`\n  - ${chalk.red('Delete')} legacy` +
		'\n\n' +
		chalk.black.underline.bold('Fields:') +
		`\n  - ${chalk.blue('Update')} articles.title` +
		'\n    - Set meta.note to Reviewed';

	return 'The following changes will be applied:\n\n' + chalk.black(inner);
}

describe('schema apply presentation', () => {
	let originalLevel: typeof chalk.level;

	beforeEach(() => {
		originalLevel = chalk.level;
		chalk.level = 1;

		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});
	});

	afterEach(() => {
		chalk.level = originalLevel;
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('renders the dry-run plan byte-identically to the original inline literals', async () => {
		await expect(apply('snapshot.json', { yes: false, dryRun: true })).rejects.toThrow();

		expect(logger.info).toHaveBeenCalledWith(expectedPlan());
	});

	it('appends the shared confirmation prompt to the plan when confirming', async () => {
		await expect(apply('snapshot.json', { yes: false, dryRun: false })).rejects.toThrow();

		const call = vi.mocked(inquirer.prompt).mock.calls[0]![0] as unknown as Array<{ message: string }>;
		expect(call[0]!.message).toBe(expectedPlan() + '\n\nWould you like to continue?');
	});
});
