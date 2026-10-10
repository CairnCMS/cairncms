import { promises as fs } from 'fs';
import inquirer from 'inquirer';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { snapshot } from './snapshot.js';

vi.mock('../../../database/index.js', () => ({
	default: vi.fn(() => ({ destroy: vi.fn() })),
	getDatabaseClient: vi.fn(() => 'sqlite'),
}));

vi.mock('../../../logger.js', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

vi.mock('../../../utils/get-snapshot.js', () => ({ getSnapshot: vi.fn(async () => ({ version: 1 })) }));

vi.mock('../../../utils/get-portable-snapshot.js', () => ({
	getPortableSnapshot: vi.fn(async () => ({ version: 2 })),
}));

vi.mock('inquirer', () => ({ default: { prompt: vi.fn(async () => ({ overwrite: true })) } }));

let dir: string;

beforeEach(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-schema-snapshot-'));
	vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
});

afterEach(async () => {
	await fs.rm(dir, { recursive: true, force: true });
	vi.restoreAllMocks();
	vi.clearAllMocks();
});

describe('schema snapshot overwrite safety on the real filesystem', () => {
	it.each([true, false])(
		'leaves a .json file that is valid YAML but invalid JSON byte-for-byte unchanged, yes %s',
		async (yes) => {
			const file = path.join(dir, 'schema.json');
			const original = 'version: 2\nrelease: old\n';
			await fs.writeFile(file, original);

			await snapshot(file, { yes, format: 'json' });

			expect(process.exit).toHaveBeenCalledWith(1);
			expect(await fs.readFile(file, 'utf8')).toBe(original);
			expect(vi.mocked(inquirer.prompt)).not.toHaveBeenCalled();
		}
	);
});
