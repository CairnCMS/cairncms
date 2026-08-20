import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedConfigPlan } from '../types/config.js';
import logger from '../logger.js';
import { computeConfigPlan } from '../utils/compute-config-plan.js';
import { readCurrentConfig } from '../utils/get-config-snapshot.js';
import { readConfigDirectory } from '../utils/read-config-directory.js';
import { serializeConfigPlan } from '../utils/serialize-config-plan.js';
import { configApply } from './commands/config/apply.js';
import { renderConfigPlan } from './commands/config/render-config-plan.js';
import { apply } from './commands/schema/apply.js';

vi.mock('./presentation.js', () => ({
	planIntro: '[[INTRO]]',
	confirmPrompt: '[[CONFIRM]]',
	heading: (label: string) => `[[HEADING:${label}]]`,
	createVerb: () => '[[CREATE]]',
	updateVerb: () => '[[UPDATE]]',
	deleteVerb: () => '[[DELETE]]',
}));

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

vi.mock('../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	isInstalled: vi.fn(async () => true),
	validateDatabaseConnection: vi.fn(async () => undefined),
}));

vi.mock('../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../utils/get-snapshot.js', () => ({ getSnapshot: vi.fn(async () => ({})) }));

vi.mock('../utils/get-snapshot-diff.js', () => ({ getSnapshotDiff: vi.fn(() => FIXTURE_DIFF) }));

vi.mock('../utils/apply-snapshot.js', () => ({ applySnapshot: vi.fn(async () => undefined) }));

vi.mock('inquirer', () => ({ default: { prompt: vi.fn(async () => ({ proceed: false })) } }));

vi.mock('fs', () => ({ promises: { readFile: vi.fn(async () => '{}') } }));

vi.mock('../utils/read-config-directory.js', () => ({
	readConfigDirectory: vi.fn(),
	isPlaceholder: vi.fn(() => false),
}));

vi.mock('../utils/get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));

vi.mock('../utils/validate-desired-config.js', () => ({ validateDesiredConfig: vi.fn(() => []) }));

vi.mock('../utils/compute-config-plan.js', () => ({
	computeConfigPlan: vi.fn(),
	validateConfigPlan: vi.fn(() => []),
}));

vi.mock('../utils/get-schema.js', () => ({ getSchema: vi.fn(async () => ({})) }));

vi.mock('../utils/enrich-config-plan.js', () => ({ enrichConfigPlan: vi.fn(async () => ({})) }));

vi.mock('../utils/serialize-config-plan.js', () => ({ serializeConfigPlan: vi.fn() }));

vi.mock('../utils/apply-config-plan.js', () => ({
	applyConfigPlan: vi.fn(),
	planHasDeletions: vi.fn(() => false),
}));

describe('config renderer sources every token from the presentation primitive', () => {
	it('emits the mocked sentinel tokens rather than hard-coded text', () => {
		const serialized: SerializedConfigPlan = {
			planVersion: 1,
			manifestVersion: 1,
			changes: [
				{
					kind: 'roles',
					operation: 'create',
					identity: { key: 'reviewer' },
					values: {
						name: 'Reviewer',
						icon: 'supervised_user_circle',
						description: null,
						admin_access: false,
						app_access: true,
						enforce_tfa: false,
						ip_access: null,
					},
				},
				{
					kind: 'roles',
					operation: 'update',
					identity: { key: 'editor' },
					fields: { name: { before: 'Editor', after: 'Managing Editor' } },
				},
				{
					kind: 'permissions',
					operation: 'delete',
					identity: { role: 'editor', collection: 'articles', action: 'delete' },
					impact: [],
				},
			],
			summary: { create: 1, update: 1, delete: 1 },
			warnings: [
				{
					code: 'COLLECTION_MISSING',
					kind: 'permissions',
					identity: { role: 'editor', collection: 'articles', action: 'read' },
					message: 'articles is not a known collection',
				},
			],
		};

		const output = renderConfigPlan(serialized);

		expect(output).toContain('[[INTRO]]');
		expect(output).toContain('[[HEADING:Roles]]');
		expect(output).toContain('[[CREATE]]');
		expect(output).toContain('[[UPDATE]]');
		expect(output).toContain('[[HEADING:Permissions]]');
		expect(output).toContain('[[DELETE]]');
		expect(output).toContain('[[HEADING:Warnings]]');
	});
});

describe('schema apply sources every token from the presentation primitive', () => {
	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('emits the mocked sentinel tokens in the dry-run plan', async () => {
		await expect(apply('snapshot.json', { yes: false, dryRun: true })).rejects.toThrow();

		const message = vi.mocked(logger.info).mock.calls[0]![0] as string;
		expect(message).toContain('[[INTRO]]');
		expect(message).toContain('[[HEADING:Collections]]');
		expect(message).toContain('[[CREATE]]');
		expect(message).toContain('[[DELETE]]');
		expect(message).toContain('[[HEADING:Fields]]');
		expect(message).toContain('[[UPDATE]]');
	});

	it('emits the mocked confirmation token when prompting', async () => {
		await expect(apply('snapshot.json', { yes: false, dryRun: false })).rejects.toThrow();

		const call = vi.mocked(inquirer.prompt).mock.calls[0]![0] as unknown as Array<{ message: string }>;
		expect(call[0]!.message).toContain('[[CONFIRM]]');
	});
});

describe('config apply sources the confirmation token from the presentation primitive', () => {
	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		vi.mocked(readConfigDirectory).mockResolvedValue({
			manifest: { version: 1, resources: ['roles'] },
			roles: [{ key: 'reviewer', name: 'Reviewer', admin_access: false, app_access: true }],
			permissions: [],
		});

		vi.mocked(readCurrentConfig).mockResolvedValue({
			config: { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] },
			currentRoleKeys: new Set<string>(),
		});

		vi.mocked(computeConfigPlan).mockReturnValue({
			roles: {
				create: [{ key: 'reviewer', name: 'Reviewer', admin_access: false, app_access: true }],
				update: [],
				delete: [],
			},
			permissions: { create: [], update: [], delete: [] },
		});

		vi.mocked(serializeConfigPlan).mockReturnValue({
			planVersion: 1,
			manifestVersion: 1,
			changes: [
				{
					kind: 'roles',
					operation: 'create',
					identity: { key: 'reviewer' },
					values: {
						name: 'Reviewer',
						icon: 'supervised_user_circle',
						description: null,
						admin_access: false,
						app_access: true,
						enforce_tfa: false,
						ip_access: null,
					},
				},
			],
			summary: { create: 1, update: 0, delete: 0 },
			warnings: [],
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('emits the mocked confirmation token in the interactive prompt for a nonempty plan', async () => {
		await expect(
			configApply('./config', { format: 'human', dryRun: false, destructive: false, yes: false })
		).rejects.toThrow();

		const call = vi.mocked(inquirer.prompt).mock.calls[0]![0] as unknown as Array<{ message: string }>;
		expect(call[0]!.message).toContain('[[CONFIRM]]');
	});
});
