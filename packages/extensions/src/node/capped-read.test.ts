import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readFileCapped } from './capped-read.js';

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function makeFile(content: string | Buffer): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-capped-'));
	created.push(dir);
	const file = path.join(dir, 'file.txt');
	await writeFile(file, content);
	return file;
}

describe('readFileCapped', () => {
	it('reads a file under the cap with its byte count', async () => {
		const file = await makeFile('hello');
		expect(await readFileCapped(file, 64)).toEqual({ ok: true, text: 'hello', bytes: 5 });
	});

	it('reads a file exactly at the cap', async () => {
		const file = await makeFile('x'.repeat(64));
		const result = await readFileCapped(file, 64);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.bytes).toBe(64);
	});

	it('rejects a file one byte over the cap without buffering it', async () => {
		const file = await makeFile('x'.repeat(65));
		expect(await readFileCapped(file, 64)).toEqual({ ok: false, reason: 'too-large' });
	});

	it('rejects a file far over the cap', async () => {
		const file = await makeFile(Buffer.alloc(1024 * 1024, 120));
		expect(await readFileCapped(file, 1024)).toEqual({ ok: false, reason: 'too-large' });
	});

	it('reports a missing file as unreadable', async () => {
		expect(await readFileCapped('/nonexistent/cairn-capped/file.txt', 64)).toEqual({
			ok: false,
			reason: 'unreadable',
		});
	});

	it('throws on a cap that would disable the bound', async () => {
		const file = await makeFile('hello');
		await expect(readFileCapped(file, 0)).rejects.toThrow(/positive safe integer/);
		await expect(readFileCapped(file, Number.NaN)).rejects.toThrow(/positive safe integer/);
		await expect(readFileCapped(file, Number.POSITIVE_INFINITY)).rejects.toThrow(/positive safe integer/);
		await expect(readFileCapped(file, 1.5)).rejects.toThrow(/positive safe integer/);
	});
});
