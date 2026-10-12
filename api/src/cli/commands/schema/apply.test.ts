import chalk from 'chalk';
import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../../../logger.js';
import { applyDiff } from '../../../utils/apply-diff.js';
import { toKeyFormSnapshot } from '../../../utils/folder-references.js';
import { getSnapshot } from '../../../utils/get-snapshot.js';
import { getVersionedHash } from '../../../utils/get-versioned-hash.js';
import { SchemaApplyFailedException } from '../../../exceptions/schema-apply-failed.js';
import { apply } from './apply.js';

const { FIXTURE_DIFF, folderKeyById } = vi.hoisted(() => {
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
		folderKeyById: new Map<string, string>(),
	};
});

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	isInstalled: vi.fn(async () => true),
	validateDatabaseConnection: vi.fn(async () => undefined),
}));

vi.mock('../../../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../../../utils/get-snapshot.js', () => ({ getSnapshot: vi.fn(async () => ({})) }));

vi.mock('../../../utils/get-target-snapshot-diff.js', () => ({
	getTargetSnapshotDiff: vi.fn(async () => FIXTURE_DIFF),
}));

vi.mock('../../../utils/folder-references.js', () => ({
	toKeyFormSnapshot: vi.fn(async (snapshot: any) => ({
		snapshot: {
			...snapshot,
			fields: (snapshot.fields ?? []).map((field: any) => ({
				...field,
				meta: { ...field.meta, options: { folder: folderKeyById.get(field.meta.options.folder) } },
			})),
		},
		folderIdByKey: new Map(),
		unresolved: [],
	})),
}));

vi.mock('../../../utils/apply-diff.js', () => ({ applyDiff: vi.fn(async () => undefined) }));

vi.mock('inquirer', () => ({ default: { prompt: vi.fn(async () => ({ proceed: false })) } }));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return { ...actual, promises: { ...actual.promises, readFile: vi.fn(async () => '{}') } };
});

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

describe('schema apply after its confirmation prompt', () => {
	const FOLDER_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

	function stored(folder: string, note: string | null = null) {
		return {
			version: 1,
			directus: '1.0.0',
			collections: [],
			fields: [{ collection: 'articles', field: 'image', meta: { interface: 'file', note, options: { folder } } }],
			relations: [],
		} as any;
	}

	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		folderKeyById.clear();
		folderKeyById.set(FOLDER_A, 'images');
		vi.mocked(inquirer.prompt).mockResolvedValue({ proceed: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('applies the computed diff after confirmation', async () => {
		vi.mocked(getSnapshot).mockResolvedValue(stored(FOLDER_A));

		await expect(apply('snapshot.json', { yes: false, dryRun: false })).rejects.toThrow();

		expect(vi.mocked(applyDiff).mock.calls[0]![0]).toBe(FIXTURE_DIFF);
	});

	it('reads the schema once and applies with --yes', async () => {
		vi.mocked(getSnapshot).mockResolvedValue(stored(FOLDER_A));

		await expect(apply('snapshot.json', { yes: true, dryRun: false })).rejects.toThrow();

		expect(getSnapshot).toHaveBeenCalledOnce();
		expect(vi.mocked(applyDiff).mock.calls[0]![0]).toBe(FIXTURE_DIFF);
	});

	it('forwards the planning hash to the apply engine across confirmation', async () => {
		vi.mocked(getSnapshot).mockResolvedValue(stored(FOLDER_A));

		await expect(apply('snapshot.json', { yes: false, dryRun: false })).rejects.toThrow();

		const keyForm = await vi.mocked(toKeyFormSnapshot).mock.results[0]!.value;
		const [, options] = vi.mocked(applyDiff).mock.calls[0]!;
		expect(options.expectedHash).toBe(getVersionedHash(keyForm.snapshot));
	});

	it('surfaces the failure diagnostic, exits unsuccessfully, and prints no success when the apply fails', async () => {
		vi.mocked(getSnapshot).mockResolvedValue(stored(FOLDER_A));

		const carrier = new SchemaApplyFailedException('unknown', { cause: new Error('mid-apply failure') });
		vi.mocked(applyDiff).mockRejectedValueOnce(carrier);

		await expect(apply('snapshot.json', { yes: true, dryRun: false })).rejects.toThrow('exit:1');

		expect(logger.error).toHaveBeenCalledWith(carrier);
		expect(logger.info).not.toHaveBeenCalledWith('Snapshot applied successfully');
	});
});
