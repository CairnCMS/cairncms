import type { Knex } from 'knex';
import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { MockedFunction } from 'vitest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { WIRED_TMP, CUSTOM_DIR } = vi.hoisted(() => {
	const wt = `${process.cwd()}/.vitest-tmp/cairncms-cjs-mjs-wired-${process.pid}-${Date.now()}`;
	return { WIRED_TMP: wt, CUSTOM_DIR: `${wt}/migrations` };
});

vi.mock('../../env.js', () => {
	const env = { EXTENSIONS_PATH: WIRED_TMP };
	return { default: env, getEnv: () => env, refreshEnv: () => undefined };
});

vi.mock('../../cache.js', () => ({ flushCaches: vi.fn().mockResolvedValue(undefined) }));

import getModuleDefault from '../../utils/get-module-default.js';
import run, { CUSTOM_MIGRATION_FILE_PATTERN } from './run.js';

const VITEST_TMP = path.join(process.cwd(), '.vitest-tmp');

describe('CUSTOM_MIGRATION_FILE_PATTERN', () => {
	it.each(['custom.js', '20260524A-test.cjs', '20260524B-test.mjs', 'a.cjs', 'b.mjs'])('accepts %s', (name) => {
		expect(CUSTOM_MIGRATION_FILE_PATTERN.test(name)).toBe(true);
	});

	it.each(['custom.json', '20260524A-test.ts', '20260524A-test.txt', '20260524A-test.js.bak', 'README.md'])(
		'rejects %s',
		(name) => {
			expect(CUSTOM_MIGRATION_FILE_PATTERN.test(name)).toBe(false);
		}
	);
});

describe('getModuleDefault normalises CJS and ESM custom-migration module shapes', () => {
	let tmp: string;

	beforeEach(() => {
		mkdirSync(VITEST_TMP, { recursive: true });
		tmp = mkdtempSync(path.join(VITEST_TMP, 'cairncms-mod-shape-'));
	});

	afterEach(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it('extracts up and down from a CJS (.cjs) module', async () => {
		const file = path.join(tmp, `cjs-${Date.now()}.cjs`);

		writeFileSync(file, "module.exports = { up: async () => 'up-cjs', down: async () => 'down-cjs' };\n");

		const mod: any = getModuleDefault(await import(`file://${file}`));

		expect(await mod.up()).toBe('up-cjs');
		expect(await mod.down()).toBe('down-cjs');
	});

	it('extracts up and down from an ESM (.mjs) module', async () => {
		const file = path.join(tmp, `mjs-${Date.now()}.mjs`);

		writeFileSync(
			file,
			"export async function up() { return 'up-mjs'; }\nexport async function down() { return 'down-mjs'; }\n"
		);

		const mod: any = getModuleDefault(await import(`file://${file}`));

		expect(await mod.up()).toBe('up-mjs');
		expect(await mod.down()).toBe('down-mjs');
	});
});

describe('run() applies a .cjs custom migration via the up and down direction paths', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	beforeAll(() => {
		mkdirSync(CUSTOM_DIR, { recursive: true });

		writeFileSync(
			path.join(CUSTOM_DIR, '00000001A-cjs-wired.cjs'),
			'function build() { return { up: async () => {}, down: async () => {} }; }\nmodule.exports = build();\n'
		);
	});

	afterAll(() => {
		rmSync(WIRED_TMP, { recursive: true, force: true });
	});

	beforeEach(() => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
	});

	it('applies the .cjs migration via run("up") in the test environment', async () => {
		tracker.on.select('directus_migrations').response([]);
		tracker.on.insert('directus_migrations').response(['ok']);

		await expect(run(db, 'up', false)).resolves.toBeUndefined();

		const inserts = tracker.history.insert;
		expect(inserts.length).toBeGreaterThan(0);
		expect(inserts[0]!.bindings).toEqual(expect.arrayContaining(['00000001A']));
	});

	it('rolls back the .cjs migration via run("down") in the test environment', async () => {
		tracker.on
			.select('directus_migrations')
			.response([{ version: '00000001A', name: 'Cjs Wired', timestamp: '2026-01-01 00:00:00' }]);

		tracker.on.delete('directus_migrations').response(['ok']);

		await expect(run(db, 'down', false)).resolves.toBeUndefined();
	});
});
