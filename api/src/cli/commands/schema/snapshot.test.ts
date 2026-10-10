import { promises as fs } from 'fs';
import inquirer from 'inquirer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import logger from '../../../logger.js';
import { getPortableSnapshot } from '../../../utils/get-portable-snapshot.js';
import { snapshot } from './snapshot.js';

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	getDatabaseClient: vi.fn(() => 'sqlite'),
}));

vi.mock('../../../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../../../utils/get-snapshot.js', () => ({
	getSnapshot: vi.fn(async () => ({ version: 1, fields: [{ meta: { options: { folder: 'stored-id' } } }] })),
}));

vi.mock('../../../utils/get-portable-snapshot.js', () => ({
	getPortableSnapshot: vi.fn(async () => ({ version: 2, fields: [{ meta: { options: { folder: 'images' } } }] })),
}));

vi.mock('inquirer', () => ({ default: { prompt: vi.fn(async () => ({ overwrite: true })) } }));

vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();

	return {
		...actual,
		promises: { ...actual.promises, readFile: vi.fn(), writeFile: vi.fn(async () => undefined) },
	};
});

function missing(): NodeJS.ErrnoException {
	return Object.assign(new Error('not found'), { code: 'ENOENT' });
}

function written(): { version: number } {
	return JSON.parse(vi.mocked(fs.writeFile).mock.calls[0]![1] as string);
}

beforeEach(() => {
	vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('schema snapshot version', () => {
	it.each([
		[1, false],
		[2, true],
	])('keeps an existing version %i file at its version', async (version, portable) => {
		vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ version }));

		await snapshot('schema.json', { yes: true, format: 'json' });

		expect(process.exit).toHaveBeenCalledWith(0);
		expect(written().version).toBe(version);
		expect(vi.mocked(getPortableSnapshot).mock.calls.length > 0).toBe(portable);
	});

	it('re-snapshots a file just edited to version 2 that still holds folder IDs', async () => {
		const edited = { version: 2, fields: [{ meta: { interface: 'file', options: { folder: 'stored-id' } } }] };
		vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify(edited));

		await snapshot('schema.json', { yes: true, format: 'json' });

		expect(process.exit).toHaveBeenCalledWith(0);

		expect(written()).toEqual({ version: 2, fields: [{ meta: { options: { folder: 'images' } } }] });
	});

	it('writes the default version to a new file', async () => {
		vi.mocked(fs.readFile).mockRejectedValueOnce(missing());

		await snapshot('schema.json', { yes: false, format: 'json' });

		expect(process.exit).toHaveBeenCalledWith(0);

		expect(written().version).toBe(1);
		expect(getPortableSnapshot).not.toHaveBeenCalled();
	});

	it('writes the default version to stdout', async () => {
		const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

		await snapshot(undefined, { yes: true, format: 'json' });

		expect(process.exit).toHaveBeenCalledWith(0);

		expect(JSON.parse(stdout.mock.calls[0]![0] as string).version).toBe(1);
		expect(fs.readFile).not.toHaveBeenCalled();
	});

	describe.each([true, false])('with yes %s', (yes) => {
		it.each([
			[
				'unreadable',
				() => vi.mocked(fs.readFile).mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'EACCES' })),
				'denied',
			],
			['unparseable', () => vi.mocked(fs.readFile).mockResolvedValueOnce('{ not: [valid'), 'could not be parsed'],
			[
				'quoted-version',
				() => vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ version: '2' })),
				'must be one of [1, 2]',
			],
			[
				'unsupported',
				() => vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ version: 3 })),
				'must be one of [1, 2]',
			],
			[
				'versionless',
				() => vi.mocked(fs.readFile).mockResolvedValueOnce(JSON.stringify({ fields: [] })),
				'"version" is required',
			],
		])('refuses an %s existing file without overwriting it', async (_label, arrange, message) => {
			arrange();

			await snapshot('schema.json', { yes, format: 'json' });

			expect(process.exit).toHaveBeenCalledWith(1);
			expect(fs.writeFile).not.toHaveBeenCalled();
			expect(vi.mocked(logger.error).mock.calls[0]![0]).toMatchObject({ message: expect.stringContaining(message) });
		});

		it('refuses a .json file whose content is valid YAML but invalid JSON', async () => {
			vi.mocked(fs.readFile).mockResolvedValueOnce('version: 2\nrelease: old\n');

			await snapshot('schema.json', { yes, format: 'json' });

			expect(process.exit).toHaveBeenCalledWith(1);
			expect(fs.writeFile).not.toHaveBeenCalled();
			expect(vi.mocked(inquirer.prompt)).not.toHaveBeenCalled();

			expect(vi.mocked(logger.error).mock.calls[0]![0]).toMatchObject({
				message: expect.stringContaining('could not be parsed'),
			});
		});
	});

	it('keeps a .yaml file at its version, parsing it as YAML', async () => {
		vi.mocked(fs.readFile).mockResolvedValueOnce('version: 2\n');

		await snapshot('schema.yaml', { yes: true, format: 'yaml' });

		expect(process.exit).toHaveBeenCalledWith(0);
		expect(fs.writeFile).toHaveBeenCalled();
		expect(getPortableSnapshot).toHaveBeenCalled();
	});
});
