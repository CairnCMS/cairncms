import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import type { CairnConfig, ConfigTranslationsAuthored } from '../../types/config.js';
import { readConfigDirectory } from '../read-config-directory.js';
import { writeConfigDirectory } from '../write-config-directory.js';
import { classifyConfigFilename } from './directory-layout.js';

vi.mock('../../logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

let tmpDir: string;

beforeEach(async () => {
	vi.clearAllMocks();
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-translations-'));
});

afterEach(async () => {
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function config(translations: ConfigTranslationsAuthored[]): CairnConfig {
	return {
		manifest: { version: 2, resources: ['translations'] },
		roles: [],
		permissions: [],
		folders: [],
		settings: [],
		'extension-settings': [],
		translations,
	};
}

async function exists(relPath: string): Promise<boolean> {
	return fs
		.access(path.join(tmpDir, relPath))
		.then(() => true)
		.catch(() => false);
}

describe('classifyConfigFilename for translations', () => {
	it('owns a literal locale filename', () => {
		expect(classifyConfigFilename('fr-FR.yaml', 'translations')).toBe('owned');
		expect(classifyConfigFilename('es-419.yaml', 'translations')).toBe('owned');
	});

	it('does not own a dotfile or a path-traversal name', () => {
		expect(classifyConfigFilename('.hidden.yaml', 'translations')).toBe('unowned');
		expect(classifyConfigFilename('..yaml', 'translations')).toBe('unowned');
	});
});

describe('translations config directory round-trip', () => {
	it('writes a literal locale file and reads it back unchanged', async () => {
		await writeConfigDirectory(
			config([{ language: 'fr-FR', translations: { greeting: 'Bonjour', '': 'empty' } }]),
			tmpDir
		);

		expect(await exists('translations/fr-FR.yaml')).toBe(true);

		const read = await readConfigDirectory(tmpDir);
		expect(read.translations).toEqual([{ language: 'fr-FR', translations: { greeting: 'Bonjour', '': 'empty' } }]);
	});

	it('removes a language file that is no longer declared', async () => {
		await writeConfigDirectory(
			config([
				{ language: 'fr-FR', translations: { a: '1' } },
				{ language: 'de-DE', translations: { b: '2' } },
			]),
			tmpDir
		);

		expect(await exists('translations/de-DE.yaml')).toBe(true);

		await writeConfigDirectory(config([{ language: 'fr-FR', translations: { a: '1' } }]), tmpDir);

		expect(await exists('translations/de-DE.yaml')).toBe(false);

		const read = await readConfigDirectory(tmpDir);
		expect(read.translations).toEqual([{ language: 'fr-FR', translations: { a: '1' } }]);
	});

	it('refuses a file whose inner language disagrees with its filename', async () => {
		await writeConfigDirectory(config([{ language: 'fr-FR', translations: { a: '1' } }]), tmpDir);

		await fs.writeFile(
			path.join(tmpDir, 'translations', 'fr-FR.yaml'),
			'language: de-DE\ntranslations:\n  a: "1"\n',
			'utf-8'
		);

		await expect(readConfigDirectory(tmpDir)).rejects.toBeInstanceOf(ConfigInvalidException);
	});

	it('refuses a file with a duplicate translation key', async () => {
		await writeConfigDirectory(config([{ language: 'fr-FR', translations: { a: '1' } }]), tmpDir);

		await fs.writeFile(
			path.join(tmpDir, 'translations', 'fr-FR.yaml'),
			'language: fr-FR\ntranslations:\n  dup: "1"\n  dup: "2"\n',
			'utf-8'
		);

		await expect(readConfigDirectory(tmpDir)).rejects.toBeInstanceOf(ConfigInvalidException);
	});
});
