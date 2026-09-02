import { BaseException } from '@cairncms/exceptions';
import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import getDatabase, { hasDatabaseConnection, isInstalled } from '../../../database/index.js';
import { ConfigPostCommitFailedException, ConfigStateChangedException } from '../../../exceptions/index.js';
import logger from '../../../logger.js';
import type {
	CairnConfig,
	ConfigPermission,
	ConfigPlan,
	ConfigStateToken,
	SerializedConfigPlan,
} from '../../../types/config.js';
import { computeConfigPlan } from '../../../utils/compute-config-plan.js';
import { CONFIG_RUN_EVENT, type ConfigRunRecord } from '../../../utils/config/run-record.js';
import { enrichConfigPlan } from '../../../utils/enrich-config-plan.js';
import { readCurrentConfig } from '../../../utils/get-config-snapshot.js';
import { getSchema } from '../../../utils/get-schema.js';
import { readConfigDirectory } from '../../../utils/read-config-directory.js';
import { serializeConfigPlan } from '../../../utils/serialize-config-plan.js';
import { validateDesiredConfig } from '../../../utils/validate-desired-config.js';
import { applyConfigPlan, planHasDeletions } from '../../../utils/apply-config-plan.js';
import { configApply } from './apply.js';

const { envOverrides } = vi.hoisted(() => ({ envOverrides: { LOG_STYLE: 'pretty' } as Record<string, unknown> }));

vi.mock('../../../env.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../../env.js')>();

	const proxy = new Proxy(actual.default, {
		get(target, prop) {
			return prop in envOverrides ? envOverrides[prop as string] : Reflect.get(target, prop);
		},
	});

	return { ...actual, default: proxy, getEnv: () => proxy };
});

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

describe('configApply run record', () => {
	const MANAGED: CairnConfig = { manifest: { version: 1, resources: ['roles'] }, roles: [], permissions: [] };

	const APPLY_RESULT = {
		roles: { created: ['editor'], updated: [], deleted: [] },
		permissions: { created: 0, updated: 0, deleted: 0 },
	};

	const PROTECTED_PLAN: ConfigPlan = {
		managedResources: ['roles'],
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

	const BASE_RECORD = {
		event: CONFIG_RUN_EVENT,
		source: 'cli',
		caller: { kind: 'system', origin: 'config-cli' },
		manifestVersion: 1,
		managedKinds: ['roles'],
	};

	function records(): ConfigRunRecord[] {
		return vi
			.mocked(logger.info)
			.mock.calls.filter((call) => (call[0] as ConfigRunRecord | undefined)?.event === CONFIG_RUN_EVENT)
			.map((call) => call[0] as ConfigRunRecord);
	}

	function presentation(): unknown[] {
		return vi
			.mocked(logger.info)
			.mock.calls.filter((call) => typeof call[0] === 'string')
			.map((call) => call[0]);
	}

	function expectOneRecord(expected: Record<string, unknown>): ConfigRunRecord {
		const emitted = records();

		expect(emitted).toHaveLength(1);
		expect(emitted[0]).toMatchObject({ ...BASE_RECORD, ...expected });
		expect(emitted[0]).not.toHaveProperty('runId');
		expect(emitted[0]).not.toHaveProperty('userAgent');

		return emitted[0]!;
	}

	async function run(options: Partial<Parameters<typeof configApply>[1]> = {}): Promise<void> {
		await configApply('./config', {
			format: 'human',
			dryRun: false,
			destructive: false,
			yes: true,
			...options,
		}).catch(() => undefined);
	}

	beforeEach(() => {
		vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`exit:${code}`);
		});

		vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		envOverrides['LOG_STYLE'] = 'raw';

		vi.mocked(readConfigDirectory).mockResolvedValue(MANAGED);

		vi.mocked(readCurrentConfig).mockResolvedValue({
			config: MANAGED,
			currentRoleKeys: new Set<string>(),
			stateToken: STATE_TOKEN,
		});

		vi.mocked(computeConfigPlan).mockReturnValue(CREATE_PLAN);
		vi.mocked(serializeConfigPlan).mockReturnValue(CREATE_SERIALIZED);
		vi.mocked(applyConfigPlan).mockResolvedValue(APPLY_RESULT as never);
	});

	afterEach(() => {
		envOverrides['LOG_STYLE'] = 'pretty';
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('records no_changes for an empty human dry run', async () => {
		vi.mocked(computeConfigPlan).mockReturnValue(EMPTY_PLAN);

		await run({ dryRun: true });

		const record = expectOneRecord({
			result: 'no_changes',
			dryRun: true,
			changes: { create: 0, update: 0, delete: 0 },
		});

		expect(record).not.toHaveProperty('errorCode');
		expect(process.exit).toHaveBeenCalledTimes(1);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it('records no_changes for an empty json dry run', async () => {
		vi.mocked(computeConfigPlan).mockReturnValue(EMPTY_PLAN);

		await run({ dryRun: true, format: 'json' });

		expectOneRecord({ result: 'no_changes', dryRun: true });
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it('records planned for a human dry run with changes', async () => {
		await run({ dryRun: true });

		expectOneRecord({ result: 'planned', dryRun: true, changes: { create: 1, update: 0, delete: 0 } });
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('records planned for a json dry run, including a protected plan', async () => {
		vi.mocked(computeConfigPlan).mockReturnValue(PROTECTED_PLAN);

		await run({ dryRun: true, format: 'json' });

		expectOneRecord({ result: 'planned', dryRun: true, changes: { create: 0, update: 0, delete: 1 } });
		expect(process.exit).toHaveBeenCalledWith(1);
	});

	it('records discarded when the operator declines the prompt', async () => {
		await run({ yes: false });

		expectOneRecord({ result: 'discarded', dryRun: false });
		expect(inquirer.prompt).toHaveBeenCalledTimes(1);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it('records refused with CONFIG_PROTECTED_RECORD for a protected mutating apply', async () => {
		vi.mocked(computeConfigPlan).mockReturnValue(PROTECTED_PLAN);

		await run();

		expectOneRecord({ result: 'refused', errorCode: 'CONFIG_PROTECTED_RECORD' });
		expect(applyConfigPlan).not.toHaveBeenCalled();
		expect(process.exit).toHaveBeenCalledWith(2);
	});

	it('records refused with DESTRUCTIVE_CHANGES_REQUIRED for deletions without the destructive flag', async () => {
		vi.mocked(planHasDeletions).mockReturnValue(true);

		await run();

		expectOneRecord({ result: 'refused', errorCode: 'DESTRUCTIVE_CHANGES_REQUIRED', destructive: false });
		expect(applyConfigPlan).not.toHaveBeenCalled();
		expect(process.exit).toHaveBeenCalledWith(2);
	});

	it('records invalid with the first failure code in document order', async () => {
		vi.mocked(validateDesiredConfig).mockReturnValue([
			{ code: 'CONFIG_IDENTITY_CONFLICT', message: 'first' },
			{ code: 'CONFIG_INVALID', message: 'second' },
		]);

		await run();

		const record = expectOneRecord({ result: 'invalid', errorCode: 'CONFIG_IDENTITY_CONFLICT' });
		expect(record).not.toHaveProperty('changes');
		expect(process.exit).toHaveBeenCalledWith(2);
	});

	it('records applied after a successful apply', async () => {
		await run();

		const record = expectOneRecord({ result: 'applied', changes: { create: 1, update: 0, delete: 0 } });
		expect(record).not.toHaveProperty('errorCode');
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it('records state_changed at exit 2 when the engine reports a concurrent change', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new ConfigStateChangedException());

		await run();

		expectOneRecord({ result: 'state_changed', errorCode: 'CONFIG_STATE_CHANGED' });
		expect(process.exit).toHaveBeenCalledWith(2);
	});

	it('records post_apply_failed at exit 3 when only the post-apply maintenance failed', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new ConfigPostCommitFailedException());

		await run();

		expectOneRecord({ result: 'post_apply_failed', errorCode: 'CONFIG_POST_COMMIT_FAILED' });
		expect(process.exit).toHaveBeenCalledWith(3);
	});

	it('records failed with UNEXPECTED for an untyped throw', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new Error('boom'));

		await run();

		expectOneRecord({ result: 'failed', errorCode: 'UNEXPECTED' });
		expect(process.exit).toHaveBeenCalledWith(3);
	});

	it('records failed with UNEXPECTED for a BaseException with a novel code', async () => {
		vi.mocked(applyConfigPlan).mockRejectedValue(new BaseException('extension failure', 500, 'EXTENSION_NOVEL'));

		await run();

		const record = expectOneRecord({ result: 'failed', errorCode: 'UNEXPECTED' });
		expect(JSON.stringify(record)).not.toContain('EXTENSION_NOVEL');
		expect(process.exit).toHaveBeenCalledWith(3);
	});

	it('emits no record under the default style while making the same presentation calls', async () => {
		await run();
		const underRaw = presentation();
		expect(records()).toHaveLength(1);

		vi.mocked(logger.info).mockClear();
		vi.mocked(process.exit).mockClear();
		envOverrides['LOG_STYLE'] = 'pretty';

		await run();

		expect(records()).toHaveLength(0);
		expect(presentation()).toEqual(underRaw);
		expect(process.exit).toHaveBeenCalledWith(0);
	});

	it.each(['raw', 'pretty'])('emits no record for the json usage error under style %s', async (style) => {
		envOverrides['LOG_STYLE'] = style;

		await run({ format: 'json', dryRun: false });

		expect(records()).toHaveLength(0);
		expect(process.exit).toHaveBeenCalledWith(2);
	});

	it.each(['raw', 'pretty'])('emits no record for an unreachable database under style %s', async (style) => {
		envOverrides['LOG_STYLE'] = style;
		vi.mocked(hasDatabaseConnection).mockResolvedValueOnce(false);

		await run();

		expect(records()).toHaveLength(0);
		expect(process.exit).toHaveBeenCalledWith(3);
	});

	it.each(['raw', 'pretty'])('emits no record for an uninstalled database under style %s', async (style) => {
		envOverrides['LOG_STYLE'] = style;
		vi.mocked(isInstalled).mockResolvedValueOnce(false);

		await run();

		expect(records()).toHaveLength(0);
		expect(process.exit).toHaveBeenCalledWith(3);
	});

	it.each(['raw', 'pretty'])('emits no record for an unreadable config tree under style %s', async (style) => {
		envOverrides['LOG_STYLE'] = style;
		vi.mocked(readConfigDirectory).mockRejectedValueOnce(new Error('unreadable'));

		await run();

		expect(records()).toHaveLength(0);
		expect(readCurrentConfig).not.toHaveBeenCalled();
		expect(process.exit).toHaveBeenCalledWith(3);
	});

	it('leaves the exit code unchanged when the logger throws on the record', async () => {
		vi.mocked(logger.info).mockImplementation((payload: unknown) => {
			if ((payload as ConfigRunRecord | undefined)?.event === CONFIG_RUN_EVENT) throw new Error('sink down');
		});

		await run();

		expect(process.exit).toHaveBeenCalledTimes(1);
		expect(process.exit).toHaveBeenCalledWith(0);
	});
});
