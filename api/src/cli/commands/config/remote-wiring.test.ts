import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
	getDatabaseMock,
	resolveRemoteTokenMock,
	fetchServerVersionMock,
	applyRemoteMock,
	fetchRemoteSnapshotMock,
	resolveConfigRootMock,
	readContainedDirectoryMock,
	writeConfigDirectoryMock,
	readOptionalConfigManifestMock,
	promptMock,
} = vi.hoisted(() => ({
	getDatabaseMock: vi.fn(),
	resolveRemoteTokenMock: vi.fn(),
	fetchServerVersionMock: vi.fn(),
	applyRemoteMock: vi.fn(),
	fetchRemoteSnapshotMock: vi.fn(),
	resolveConfigRootMock: vi.fn(),
	readContainedDirectoryMock: vi.fn(),
	writeConfigDirectoryMock: vi.fn(),
	readOptionalConfigManifestMock: vi.fn(),
	promptMock: vi.fn(),
}));

vi.mock('../../../database/index.js', () => ({
	default: getDatabaseMock,
	hasDatabaseConnection: vi.fn(async () => true),
	isInstalled: vi.fn(async () => true),
}));

vi.mock('../../../logger.js', () => ({ default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock('../../../utils/read-config-directory.js', () => ({
	readConfigDirectory: vi.fn(async () => ({ manifest: { version: 1, resources: [] }, roles: [], permissions: [] })),
	readOptionalConfigManifest: readOptionalConfigManifestMock,
	isPlaceholder: vi.fn(() => false),
}));

vi.mock('../../../utils/config-path-safety.js', () => ({
	resolveConfigRoot: resolveConfigRootMock,
	readContainedDirectory: readContainedDirectoryMock,
}));

vi.mock('../../../utils/write-config-directory.js', () => ({ writeConfigDirectory: writeConfigDirectoryMock }));

vi.mock('inquirer', () => ({ default: { prompt: promptMock } }));

vi.mock('./remote-token.js', () => ({
	resolveRemoteToken: resolveRemoteTokenMock,
	RemoteTokenError: class extends Error {},
}));

vi.mock('./operator-remote-transport.js', () => ({ createOperatorRemoteTransport: vi.fn(async () => ({})) }));

vi.mock('./remote-client.js', () => ({
	fetchServerVersion: fetchServerVersionMock,
	assertServerSupportsRemoteConfig: vi.fn(),
	applyRemote: applyRemoteMock,
	fetchRemoteSnapshot: fetchRemoteSnapshotMock,
}));

import logger from '../../../logger.js';
import { configApply } from './apply.js';
import { configSnapshot } from './snapshot.js';

const EMPTY_PLAN = {
	planVersion: 2,
	manifestVersion: 1,
	changes: [],
	summary: { create: 0, update: 0, delete: 0 },
	protections: [],
	warnings: [],
};

const PROTECTED_PLAN = {
	...EMPTY_PLAN,
	protections: [
		{
			code: 'ADMIN_CONTINUITY_REQUIRED',
			message: 'Would remove the last administrator',
			contributors: [{ kind: 'roles', operation: 'delete', identity: { key: 'admin' } }],
		},
	],
};

beforeEach(() => {
	vi.clearAllMocks();
	getDatabaseMock.mockReturnValue({ destroy: vi.fn() });
	resolveRemoteTokenMock.mockReturnValue('remote-token');
	fetchServerVersionMock.mockResolvedValue('1.6.0');
	applyRemoteMock.mockResolvedValue({ plan: EMPTY_PLAN });
	fetchRemoteSnapshotMock.mockResolvedValue({ manifest: { version: 1, resources: [] }, roles: [], permissions: [] });
	resolveConfigRootMock.mockResolvedValue('/cfg');
	readContainedDirectoryMock.mockResolvedValue([]);
	readOptionalConfigManifestMock.mockResolvedValue(undefined);
	writeConfigDirectoryMock.mockResolvedValue(undefined);

	vi.spyOn(process, 'exit').mockImplementation((code) => {
		throw new Error(`exit:${code}`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('remote configApply wiring', () => {
	it('runs the remote path without touching the local database', async () => {
		await configApply('./cfg', {
			yes: false,
			dryRun: true,
			destructive: false,
			format: 'human',
			url: 'https://cms.example',
		}).catch(() => undefined);

		expect(getDatabaseMock).not.toHaveBeenCalled();
		expect(fetchServerVersionMock).toHaveBeenCalledOnce();

		expect(applyRemoteMock).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
			dryRun: true,
			destructive: false,
		});
	});

	it('refuses a mutating remote apply without --yes before reading the token or the network', async () => {
		await configApply('./cfg', {
			yes: false,
			dryRun: false,
			destructive: false,
			format: 'human',
			url: 'https://cms.example',
		}).catch(() => undefined);

		expect(process.exit).toHaveBeenCalledWith(2);
		expect(resolveRemoteTokenMock).not.toHaveBeenCalled();
		expect(fetchServerVersionMock).not.toHaveBeenCalled();
	});

	it('warns on stderr when the target uses http', async () => {
		await configApply('./cfg', {
			yes: false,
			dryRun: true,
			destructive: false,
			format: 'human',
			url: 'http://localhost:8055',
		}).catch(() => undefined);

		expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('http://'));
	});

	it('treats a standing protection with no changes as non-clean and renders it', async () => {
		applyRemoteMock.mockResolvedValue({ plan: PROTECTED_PLAN });

		await configApply('./cfg', {
			yes: false,
			dryRun: true,
			destructive: false,
			format: 'human',
			url: 'https://cms.example',
		}).catch(() => undefined);

		expect(process.exit).toHaveBeenCalledWith(1);
		expect(vi.mocked(logger.info)).toHaveBeenCalledWith(expect.stringContaining('Would remove the last administrator'));
	});
});

describe('remote configSnapshot wiring', () => {
	it('runs the remote path without touching the local database', async () => {
		await configSnapshot('./cfg', { yes: false, url: 'https://cms.example' }).catch(() => undefined);

		expect(getDatabaseMock).not.toHaveBeenCalled();
		expect(fetchServerVersionMock).toHaveBeenCalledOnce();
		expect(fetchRemoteSnapshotMock).toHaveBeenCalledOnce();
		expect(writeConfigDirectoryMock).toHaveBeenCalledOnce();
	});

	it('refuses --token-stdin into a non-empty directory without --yes before reading the token or the network', async () => {
		readContainedDirectoryMock.mockResolvedValue(['admin.yaml']);

		await configSnapshot('./cfg', { yes: false, url: 'https://cms.example', tokenStdin: true }).catch(() => undefined);

		expect(process.exit).toHaveBeenCalledWith(2);
		expect(resolveRemoteTokenMock).not.toHaveBeenCalled();
		expect(fetchServerVersionMock).not.toHaveBeenCalled();
		expect(promptMock).not.toHaveBeenCalled();
	});

	it('does not write to the directory when the snapshot fails validation', async () => {
		fetchRemoteSnapshotMock.mockRejectedValue(Object.assign(new Error('malformed snapshot'), { exitCode: 3 }));

		await configSnapshot('./cfg', { yes: false, url: 'https://cms.example' }).catch(() => undefined);

		expect(process.exit).toHaveBeenCalledWith(3);
		expect(writeConfigDirectoryMock).not.toHaveBeenCalled();
	});
});
