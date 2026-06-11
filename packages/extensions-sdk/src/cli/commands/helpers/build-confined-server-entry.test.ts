import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	buildConfinedServerEntry as exportedBuild,
	ConfinedBuildError as ExportedError,
} from '../../../confined-build.js';
import {
	buildConfinedServerEntry,
	ConfinedBuildError,
	watchConfinedServerEntry,
} from './build-confined-server-entry.js';

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();

	while (!predicate()) {
		if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the watcher');
		await new Promise((settle) => setTimeout(settle, 50));
	}
}

let outer: string;
let dir: string;

beforeEach(() => {
	outer = mkdtempSync(join(tmpdir(), 'confined-build-'));
	dir = join(outer, 'pkg');
	mkdirSync(dir);
});

afterEach(() => {
	rmSync(outer, { recursive: true, force: true });
});

function write(relativePath: string, source: string): string {
	const file = join(dir, relativePath);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, source);
	return file;
}

// The IIFE assigns `var CairnOperation`. Evaluate it and return the global.
function evalGlobal(code: string): { default: { id: string; handler: unknown } } {
	return new Function(`${code}\nreturn CairnOperation;`)();
}

describe('buildConfinedServerEntry', () => {
	it('builds a self-contained IIFE exposing CairnOperation.default', async () => {
		const input = write('server.js', "export default { id: 'flow-operation.x', handler: async () => ({ ok: true }) };");

		const { code } = await buildConfinedServerEntry({ input, root: dir });
		const global = evalGlobal(code);

		expect(global.default.id).toBe('flow-operation.x');
		expect(typeof global.default.handler).toBe('function');
	});

	it('bundles a relative import and leaves no module references', async () => {
		write('config.js', "export const id = 'flow-operation.x';");

		const input = write(
			'server.js',
			"import { id } from './config.js'; export default { id, handler: async () => ({ ok: true }) };"
		);

		const { code } = await buildConfinedServerEntry({ input, root: dir });

		expect(evalGlobal(code).default.id).toBe('flow-operation.x');
		expect(code).not.toContain('require(');
		expect(code).not.toContain('node:');
		expect(code).not.toContain('import(');
	});

	it('bundles an in-root import outside the entry directory', async () => {
		write('lib/util.js', "export const id = 'flow-operation.x';");

		const input = write(
			'src/server.js',
			"import { id } from '../lib/util.js'; export default { id, handler: async () => ({ ok: true }) };"
		);

		const { code } = await buildConfinedServerEntry({ input, root: dir });
		expect(evalGlobal(code).default.id).toBe('flow-operation.x');
	});

	it('writes the built entry to the output path byte-for-byte', async () => {
		const input = write('server.js', "export default { id: 'x', handler: () => ({}) };");
		const output = join(dir, 'server.built.js');

		const { code } = await buildConfinedServerEntry({ input, root: dir, output });

		expect(readFileSync(output, 'utf8')).toBe(code);
	});

	it('creates the output directory for a fresh package and resolves it against the root', async () => {
		const input = write('src/server.js', "export default { id: 'x', handler: () => ({}) };");

		const { code } = await buildConfinedServerEntry({ input, root: dir, output: 'dist/server.js' });

		expect(readFileSync(join(dir, 'dist', 'server.js'), 'utf8')).toBe(code);
	});

	it('sanitizes a write failure', async () => {
		const input = write('src/server.js', "export default { id: 'x', handler: () => ({}) };");
		write('dist', '');

		let message = '';

		try {
			await buildConfinedServerEntry({ input, root: dir, output: 'dist/server.js' });
		} catch (caught) {
			expect(caught).toBeInstanceOf(ConfinedBuildError);
			message = (caught as Error).message;
		}

		expect(message).toBe('the built entry could not be written to the output path');
		expect(message).not.toContain(dir);
	});

	it('is deterministic across rebuilds with no machine path in the output', async () => {
		// Working-directory independence is structural (paths anchor to the resolved
		// root), and chdir is unavailable in a vitest worker, so the property pins
		// as byte stability plus the absence of any machine path in the bytes.
		const input = write('server.js', "export default { id: 'x', handler: async () => ({ ok: true }) };");

		const first = await buildConfinedServerEntry({ input, root: dir });
		const second = await buildConfinedServerEntry({ input, root: dir });

		expect(first.code).toBe(second.code);
		expect(first.code).not.toContain(outer);
	});

	it('fails closed on a Node builtin import', async () => {
		const input = write(
			'server.js',
			"import { readFile } from 'node:fs'; export default { id: 'x', handler: () => ({}) };"
		);

		await expect(buildConfinedServerEntry({ input, root: dir })).rejects.toBeInstanceOf(ConfinedBuildError);
	});

	it('fails closed on an unresolved import', async () => {
		const input = write(
			'server.js',
			"import x from 'no-such-package'; export default { id: 'x', handler: () => ({ x }) };"
		);

		await expect(buildConfinedServerEntry({ input, root: dir })).rejects.toBeInstanceOf(ConfinedBuildError);
	});

	it('produces a sanitized error without the absolute source path', async () => {
		const input = write('server.js', "import { readFile } from 'node:fs'; export default {};");

		let message = '';

		try {
			await buildConfinedServerEntry({ input, root: dir });
		} catch (caught) {
			message = (caught as Error).message;
		}

		expect(message).toMatch(/could not resolve/i);
		expect(message).not.toContain(dir);
	});
});

describe('containment', () => {
	it('refuses a symlinked-outside local import and accepts the same file in place', async () => {
		writeFileSync(join(outer, 'shared.js'), "export const id = 'flow-operation.x';");
		symlinkSync(join(outer, 'shared.js'), join(dir, 'shared.js'));

		const input = write(
			'server.js',
			"import { id } from './shared.js'; export default { id, handler: async () => ({ ok: true }) };"
		);

		let message = '';

		try {
			await buildConfinedServerEntry({ input, root: dir });
		} catch (caught) {
			expect(caught).toBeInstanceOf(ConfinedBuildError);
			message = (caught as Error).message;
		}

		expect(message).toContain('resolves outside the package root');
		expect(message).toContain('shared.js');
		expect(message).not.toContain(outer);

		rmSync(join(dir, 'shared.js'));
		write('shared.js', "export const id = 'flow-operation.x';");

		const { code } = await buildConfinedServerEntry({ input, root: dir });
		expect(evalGlobal(code).default.id).toBe('flow-operation.x');
	});

	it('accepts a store-layout dependency whose real path keeps a node_modules segment', async () => {
		// The pnpm workspace shape: the package's node_modules entry symlinks into a
		// virtual store outside the package root but still under node_modules.
		const store = join(outer, 'node_modules', '.pnpm', 'dep@1.0.0', 'node_modules', 'dep');
		mkdirSync(store, { recursive: true });
		writeFileSync(join(store, 'package.json'), JSON.stringify({ name: 'dep', exports: { '.': './index.js' } }));
		writeFileSync(join(store, 'index.js'), "export const id = 'flow-operation.x';");

		mkdirSync(join(dir, 'node_modules'), { recursive: true });
		symlinkSync(store, join(dir, 'node_modules', 'dep'));

		const input = write(
			'server.js',
			"import { id } from 'dep'; export default { id, handler: async () => ({ ok: true }) };"
		);

		const { code } = await buildConfinedServerEntry({ input, root: dir });
		expect(evalGlobal(code).default.id).toBe('flow-operation.x');
	});

	it('refuses a linked local dependency that resolves to a bare directory', async () => {
		// The file:, link:, workspace:, and npm-link shape: under node_modules by
		// position, but resolving to local source the scanner never reads.
		const shared = join(outer, 'shared-lib');
		mkdirSync(shared, { recursive: true });
		writeFileSync(join(shared, 'package.json'), JSON.stringify({ name: 'shared-lib', exports: { '.': './index.js' } }));
		writeFileSync(join(shared, 'index.js'), "export const id = 'flow-operation.x';");

		mkdirSync(join(dir, 'node_modules'), { recursive: true });
		symlinkSync(shared, join(dir, 'node_modules', 'shared-lib'));

		const input = write(
			'server.js',
			"import { id } from 'shared-lib'; export default { id, handler: async () => ({ ok: true }) };"
		);

		await expect(buildConfinedServerEntry({ input, root: dir })).rejects.toBeInstanceOf(ConfinedBuildError);
	});
});

describe('watchConfinedServerEntry', () => {
	it('builds initially, rebuilds on change, and reports failures sanitized', async () => {
		write('src/server.js', "export default { id: 'one', handler: () => ({}) };");
		const results: Array<{ ok: true } | { ok: false; message: string }> = [];

		const watcher = await watchConfinedServerEntry({
			input: 'src/server.js',
			root: dir,
			output: 'dist/server.js',
			onRebuild: (result) => results.push(result),
		});

		try {
			await waitFor(() => results.length >= 1);
			expect(results[0]).toEqual({ ok: true });

			const builtPath = join(dir, 'dist', 'server.js');
			expect(evalGlobal(readFileSync(builtPath, 'utf8')).default.id).toBe('one');

			write('src/server.js', "export default { id: 'two', handler: () => ({}) };");
			await waitFor(() => results.length >= 2);
			expect(results[1]).toEqual({ ok: true });
			expect(evalGlobal(readFileSync(builtPath, 'utf8')).default.id).toBe('two');

			write('src/server.js', "import { readFile } from 'node:fs'; export default { id: 'x', handler: () => ({}) };");
			await waitFor(() => results.length >= 3);

			const failure = results[2];
			expect(failure).toMatchObject({ ok: false });

			if (failure && !failure.ok) {
				expect(failure.message).toMatch(/could not resolve/i);
				expect(failure.message).not.toContain(dir);
			}
		} finally {
			await watcher.close();
		}
	}, 30_000);
});

describe('the confined-build subpath', () => {
	it('re-exports the helper and the error type', () => {
		expect(exportedBuild).toBe(buildConfinedServerEntry);
		expect(ExportedError).toBe(ConfinedBuildError);
	});
});
