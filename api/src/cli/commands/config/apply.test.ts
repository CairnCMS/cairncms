import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import getDatabase from '../../../database/index.js';
import logger from '../../../logger.js';
import type {
	CairnConfig,
	ConfigPermission,
	ConfigPlan,
	ConfigStateToken,
	SerializedConfigPlan,
} from '../../../types/config.js';
import { computeConfigPlan } from '../../../utils/compute-config-plan.js';
import { enrichConfigPlan } from '../../../utils/enrich-config-plan.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { getSchema } from '../../../utils/get-schema.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { serializeConfigPlan } from '../../../utils/serialize-config-plan.js';
import { applyConfigPlan } from '../../../utils/apply-config-plan.js';
import { configApply } from './apply.js';

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	isInstalled: vi.fn(async () => true),
	hasDatabaseConnection: vi.fn(async () => true),
}));

vi.mock('../../../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock('../../../utils/read-config-directory.js', () => ({
	readConfigDirectory: vi.fn(),
	isPlaceholder: vi.fn(() => false),
}));

vi.mock('../../../utils/get-config-snapshot.js', () => ({ readCurrentConfig: vi.fn() }));

vi.mock('../../../utils/validate-desired-config.js', () => ({ validateDesiredConfig: vi.fn(() => []) }));

vi.mock('../../../utils/compute-config-plan.js', () => ({
	computeConfigPlan: vi.fn(),
}));

vi.mock('../../../utils/get-schema.js', () => ({ getSchema: vi.fn(async () => ({})) }));

vi.mock('../../../utils/enrich-config-plan.js', () => ({ enrichConfigPlan: vi.fn(async () => ({})) }));

vi.mock('../../../utils/serialize-config-plan.js', () => ({ serializeConfigPlan: vi.fn() }));

vi.mock('../../../utils/apply-config-plan.js', () => ({
	applyConfigPlan: vi.fn(),
	planHasDeletions: vi.fn(() => false),
}));

vi.mock('inquirer', () => ({ default: { prompt: vi.fn(async () => ({ proceed: false })) } }));

const EMPTY_PLAN: ConfigPlan = {
	managedResources: ['permissions'],
	roles: { create: [], update: [], delete: [] },
	permissions: { create: [], update: [], delete: [] },
	protections: [],
};

const STATE_TOKEN: ConfigStateToken = { resources: ['roles'], digest: 'cli-digest' };

const CREATE_PLAN: ConfigPlan = {
	managedResources: ['roles'],
	roles: {
		create: [
			{
				key: 'editor',
				name: 'Editor',
				admin_access: false,
				app_access: true,
				icon: null,
				enforce_tfa: false,
				description: null,
				ip_access: null,
			},
		],
		update: [],
		delete: [],
	},
	permissions: { create: [], update: [], delete: [] },
	protections: [],
};

const CREATE_SERIALIZED: SerializedConfigPlan = {
	planVersion: 2,
	manifestVersion: 1,
	changes: [
		{
			kind: 'roles',
			operation: 'create',
			identity: { key: 'editor' },
			values: {
				name: 'Editor',
				admin_access: false,
				app_access: true,
				icon: null,
				enforce_tfa: false,
				description: null,
				ip_access: null,
			},
		},
	],
	summary: { create: 1, update: 0, delete: 0 },
	protections: [],
	warnings: [],
};

const MISSING_COLLECTION_PERMISSION: ConfigPermission = {
	collection: 'articles',
	action: 'read',
	permissions: null,
	validation: null,
	presets: null,
	fields: null,
};

describe('configApply usage ordering', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('rejects --format json without --dry-run before constructing the database or reading the config path', async () => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		await expect(
			configApply('./config', { format: 'json', dryRun: false, destructive: false, yes: false })
		).rejects.toThrow('exit:2');

		expect(logger.error).toHaveBeenCalledWith('JSON output is only available with --dry-run.');
		expect(getDatabase).not.toHaveBeenCalled();
		expect(readConfigDirectory).not.toHaveBeenCalled();
	});
});

describe('configApply empty plan warnings', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('surfaces warnings in human mode even when the plan has no changes, at exit 0', async () => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		const managed: CairnConfig = {
			manifest: { version: 1, resources: ['permissions'] },
			roles: [],
			permissions: [{ role: 'editor', permissions: [MISSING_COLLECTION_PERMISSION] }],
		};

		vi.mocked(readConfigDirectory).mockResolvedValue(managed);

		vi.mocked(readCurrentConfig).mockResolvedValue({ config: managed, currentRoleKeys: new Set<string>(['editor']) });

		vi.mocked(computeConfigPlan).mockReturnValue(EMPTY_PLAN);

		const serialized: SerializedConfigPlan = {
			planVersion: 2,
			manifestVersion: 1,
			changes: [],
			summary: { create: 0, update: 0, delete: 0 },
			warnings: [
				{
					code: 'COLLECTION_MISSING',
					kind: 'permissions',
					identity: { role: 'editor', collection: 'articles', action: 'read' },
					message: 'Permission for role "editor" targets collection "articles", which does not exist in the schema.',
				},
			],
			protections: [],
		};

		vi.mocked(serializeConfigPlan).mockReturnValue(serialized);

		await expect(
			configApply('./config', { format: 'human', dryRun: true, destructive: false, yes: false })
		).rejects.toThrow();

		expect(process.exit).toHaveBeenCalledWith(0);
		expect(logger.info).toHaveBeenCalledTimes(1);

		const message = vi.mocked(logger.info).mock.calls[0]![0] as string;
		expect(message).toContain('No changes to apply.');
		expect(message).toContain('does not exist in the schema');
	});
});

describe('configApply empty plan with unmanaged permissions', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('reports no changes without querying schema, enrichment, or serialization when permissions are unmanaged', async () => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		const rolesOnly: CairnConfig = {
			manifest: { version: 1, resources: ['roles'] },
			roles: [],
			permissions: [],
		};

		vi.mocked(readConfigDirectory).mockResolvedValue(rolesOnly);

		vi.mocked(readCurrentConfig).mockResolvedValue({ config: rolesOnly, currentRoleKeys: new Set<string>() });

		vi.mocked(computeConfigPlan).mockReturnValue(EMPTY_PLAN);

		await expect(
			configApply('./config', { format: 'human', dryRun: true, destructive: false, yes: false })
		).rejects.toThrow();

		expect(process.exit).toHaveBeenCalledWith(0);
		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info).toHaveBeenCalledWith('No changes to apply.');
		expect(getSchema).not.toHaveBeenCalled();
		expect(enrichConfigPlan).not.toHaveBeenCalled();
		expect(serializeConfigPlan).not.toHaveBeenCalled();
	});
});

describe('configApply protected plan', () => {
	const PROTECTED_PLAN: ConfigPlan = {
		roles: { create: [], update: [], delete: ['administrator'] },
		permissions: { create: [], update: [], delete: [] },
		protections: [
			{
				code: 'ADMIN_CONTINUITY_REQUIRED',
				message: 'Configuration must retain at least one role with administrator access.',
				contributors: [{ kind: 'roles', operation: 'delete', identity: { key: 'administrator' } }],
			},
		],
	};

	const PROTECTED_SERIALIZED: SerializedConfigPlan = {
		planVersion: 2,
		manifestVersion: 1,
		changes: [{ kind: 'roles', operation: 'delete', identity: { key: 'administrator' }, impact: [] }],
		summary: { create: 0, update: 0, delete: 1 },
		warnings: [],
		protections: PROTECTED_PLAN.protections,
	};

	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		const rolesOnly: CairnConfig = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] };
		vi.mocked(readConfigDirectory).mockResolvedValue(rolesOnly);
		vi.mocked(readCurrentConfig).mockResolvedValue({ config: rolesOnly, currentRoleKeys: new Set<string>() });
		vi.mocked(computeConfigPlan).mockReturnValue(PROTECTED_PLAN);
		vi.mocked(serializeConfigPlan).mockReturnValue(PROTECTED_SERIALIZED);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('exits 2 on a mutating apply without prompting or calling the engine', async () => {
		await expect(
			configApply('./config', { format: 'human', dryRun: false, destructive: false, yes: false })
		).rejects.toThrow();

		expect(process.exit).toHaveBeenCalledWith(2);
		expect(inquirer.prompt).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();
	});

	it('emits the annotated plan and exits 1 for --format json without prompting or calling the engine', async () => {
		await expect(
			configApply('./config', { format: 'json', dryRun: true, destructive: false, yes: false })
		).rejects.toThrow();

		expect(process.exit).toHaveBeenCalledWith(1);
		expect(inquirer.prompt).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();
	});

	it('refuses from the internal plan even when the serialized projection drops protections, with destructive set', async () => {
		vi.mocked(serializeConfigPlan).mockReturnValue({ ...PROTECTED_SERIALIZED, protections: [] });

		await expect(
			configApply('./config', { format: 'human', dryRun: false, destructive: true, yes: false })
		).rejects.toThrow();

		expect(process.exit).toHaveBeenCalledWith(2);
		expect(inquirer.prompt).not.toHaveBeenCalled();
		expect(applyConfigPlan).not.toHaveBeenCalled();
	});
});

describe('configApply state token forwarding', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('forwards the plan-time state token to the apply engine', async () => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		const managed: CairnConfig = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] };

		vi.mocked(readConfigDirectory).mockResolvedValue(managed);

		vi.mocked(readCurrentConfig).mockResolvedValue({
			config: managed,
			currentRoleKeys: new Set<string>(),
			stateToken: STATE_TOKEN,
		});

		vi.mocked(computeConfigPlan).mockReturnValue(CREATE_PLAN);
		vi.mocked(serializeConfigPlan).mockReturnValue(CREATE_SERIALIZED);

		vi.mocked(applyConfigPlan).mockResolvedValue({
			roles: { created: [], updated: [], deleted: [] },
			permissions: { created: 0, updated: 0, deleted: 0 },
		} as never);

		await configApply('./config', { format: 'human', dryRun: false, destructive: false, yes: true }).catch(
			() => undefined
		);

		expect(process.exit).toHaveBeenCalledWith(0);
		expect(applyConfigPlan).toHaveBeenCalledTimes(1);
		expect(vi.mocked(applyConfigPlan).mock.calls[0]![1]).toMatchObject({ expectedStateToken: STATE_TOKEN });
	});
});
