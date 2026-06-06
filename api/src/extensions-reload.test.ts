import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { TMP } = vi.hoisted(() => ({ TMP: `/tmp/cairncms-ext-reload-${process.pid}-${Date.now()}` }));

vi.mock('./env.js', () => {
	const env = {
		EXTENSIONS_PATH: TMP,
		PACKAGE_FILE_LOCATION: TMP,
		SERVE_APP: false,
		EXTENSIONS_AUTO_RELOAD: false,
		NODE_ENV: 'development',
		DB_CLIENT: 'sqlite3',
		DB_FILENAME: ':memory:',
	};

	return { default: env, getEnv: () => env, refreshEnv: () => undefined };
});

vi.mock('node:fs/promises', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:fs/promises')>();

	return {
		...actual,
		// vite cannot glob-resolve the built-in operations import under SSR, so report none.
		readdir: vi.fn((p: any, ...args: any[]) =>
			String(p).endsWith('operations') ? Promise.resolve([]) : (actual.readdir as any)(p, ...args)
		),
	};
});

import { ExtensionManager } from './extensions.js';

function writeExtension(type: string, name: string, source: string): void {
	const dir = path.join(TMP, type, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, 'index.js'), source);
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
	for (let attempt = 0; attempt < 80; attempt++) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}

	throw new Error('waitFor timed out');
}

function count(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1;
}

describe('ExtensionManager reload lifecycle', () => {
	beforeEach(() => {
		rmSync(TMP, { recursive: true, force: true });
		mkdirSync(TMP, { recursive: true });
		writeFileSync(path.join(TMP, 'package.json'), JSON.stringify({ name: 'reload-host', dependencies: {} }));
	});

	afterAll(() => rmSync(TMP, { recursive: true, force: true }));

	it('discovers and registers a newly added endpoint on reload, no restart', async () => {
		writeExtension('endpoints', 'ep-a', "export default (router) => router.get('/', (_req, res) => res.send('A'));\n");

		const manager = new ExtensionManager();
		await manager.initialize({ schedule: false, watch: false });

		const app = express();
		app.use(manager.getEndpointRouter());

		await request(app).get('/ep-a').expect(200, 'A');
		await request(app).get('/ep-b').expect(404);

		writeExtension('endpoints', 'ep-b', "export default (router) => router.get('/', (_req, res) => res.send('B'));\n");
		manager.reload();

		await waitFor(async () => (await request(app).get('/ep-b')).status === 200);
		await request(app).get('/ep-b').expect(200, 'B');
		await request(app).get('/ep-a').expect(200, 'A');
	});

	it('clears hook embeds on reload so they are not duplicated', async () => {
		writeExtension('hooks', 'hook-a', "export default ({ embed }) => embed('head', '<x>EMBED_A</x>');\n");

		const manager = new ExtensionManager();
		await manager.initialize({ schedule: false, watch: false });

		expect(count(manager.getEmbeds().head, 'EMBED_A')).toBe(1);

		writeExtension('hooks', 'hook-b', "export default ({ embed }) => embed('head', '<x>EMBED_B</x>');\n");
		manager.reload();

		await waitFor(() => manager.getEmbeds().head.includes('EMBED_B'));

		expect(count(manager.getEmbeds().head, 'EMBED_A')).toBe(1);
		expect(count(manager.getEmbeds().head, 'EMBED_B')).toBe(1);
	});

	it('survives removal of a loaded server extension and keeps the reload queue working', async () => {
		writeExtension('endpoints', 'ep-a', "export default (router) => router.get('/', (_req, res) => res.send('A'));\n");

		const manager = new ExtensionManager();
		await manager.initialize({ schedule: false, watch: false });

		const app = express();
		app.use(manager.getEndpointRouter());

		await request(app).get('/ep-a').expect(200, 'A');

		rmSync(path.join(TMP, 'endpoints', 'ep-a'), { recursive: true, force: true });
		manager.reload();

		await waitFor(async () => (await request(app).get('/ep-a')).status === 404);

		writeExtension('endpoints', 'ep-b', "export default (router) => router.get('/', (_req, res) => res.send('B'));\n");
		manager.reload();

		await waitFor(async () => (await request(app).get('/ep-b')).status === 200);
		await request(app).get('/ep-b').expect(200, 'B');
	});
});
