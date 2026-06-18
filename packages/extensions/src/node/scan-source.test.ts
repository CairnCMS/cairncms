import { afterEach, describe, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	MAX_SOURCE_FILE_BYTES,
	MAX_SOURCE_FILE_COUNT,
	MAX_SOURCE_GRAPH_BYTES,
	MAX_SOURCE_IMPORT_ATTEMPTS,
	scanCandidateSource,
} from './scan-source.js';
import type { ExtensionValidationReasonCode } from '../validation.js';

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function scan(source: string): Promise<ExtensionValidationReasonCode[]> {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
	created.push(dir);
	await writeFile(path.join(dir, 'index.js'), source);
	const { reasons } = await scanCandidateSource({ root: dir, entries: ['index.js'] });
	return reasons.map((reason) => reason.code);
}

describe('scanCandidateSource', () => {
	it('flags raw filesystem access', async () => {
		const codes = await scan("import { readFile } from 'node:fs/promises';\nexport default {};\n");
		expect(codes).toContain('uses-raw-fs');
	});

	it('flags raw network access through a network package', async () => {
		const codes = await scan("import axios from 'axios';\nexport default {};\n");
		expect(codes).toContain('uses-raw-network');
	});

	it('flags raw network access through ambient fetch', async () => {
		const codes = await scan('export default { run: () => fetch("https://example.com") };\n');
		expect(codes).toContain('uses-raw-network');
	});

	it('flags dynamic require', async () => {
		const codes = await scan('const name = "node:fs";\nexport default { mod: require(name) };\n');
		expect(codes).toContain('uses-dynamic-require');
	});

	it('flags dynamic import', async () => {
		const codes = await scan('export default { load: (name) => import(name) };\n');
		expect(codes).toContain('uses-dynamic-import');
	});

	it('flags dynamic code evaluation', async () => {
		const codes = await scan('export default { run: (src) => eval(src) };\n');
		expect(codes).toContain('uses-dynamic-code');
	});

	it('flags an internal cairncms import', async () => {
		const codes = await scan("import { thing } from '@cairncms/api';\nexport default { thing };\n");
		expect(codes).toContain('uses-internal-cairncms-import');
	});

	it('does not flag a member call to fetch as raw network', async () => {
		const codes = await scan('export default { run: (client, x) => client.fetch(x) };\n');
		expect(codes).not.toContain('uses-raw-network');
	});

	it('does not flag a member call to require with a string argument', async () => {
		const codes = await scan("export default { run: (obj) => obj.require('lodash') };\n");
		expect(codes).not.toContain('uses-dynamic-require');
	});

	it('does not flag a commented-out import', async () => {
		const codes = await scan("// import { readFile } from 'node:fs/promises';\nexport default {};\n");
		expect(codes).not.toContain('uses-raw-fs');
	});

	it('does not flag a module specifier inside a string literal', async () => {
		const codes = await scan('export default { label: "node:fs/promises", other: "axios" };\n');
		expect(codes).toHaveLength(0);
	});

	it('flags @cairncms/extensions as an internal import', async () => {
		const codes = await scan("import { x } from '@cairncms/extensions';\nexport default { x };\n");
		expect(codes).toContain('uses-internal-cairncms-import');
	});

	it('flags @cairncms/extensions-app-api as an internal import', async () => {
		const codes = await scan("import { x } from '@cairncms/extensions-app-api';\nexport default { x };\n");
		expect(codes).toContain('uses-internal-cairncms-import');
	});

	it('allows @cairncms/extensions-server-api', async () => {
		const codes = await scan(
			"import { defineFlowOperation } from '@cairncms/extensions-server-api';\nexport default {};\n"
		);

		expect(codes).not.toContain('uses-internal-cairncms-import');
		expect(codes).toHaveLength(0);
	});

	it('reports source-unavailable when no entry resolves to a readable file', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(dir);
		const { reasons } = await scanCandidateSource({ root: dir, entries: ['missing.js'] });
		expect(reasons.map((reason) => reason.code)).toContain('source-unavailable');
	});

	it('refuses an entry that symlinks outside the package root without reading it', async () => {
		const base = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(base);
		const root = path.join(base, 'pkg');
		await mkdir(root);
		await writeFile(path.join(base, 'outside.js'), "import { readFile } from 'node:fs/promises';\n");
		await symlink(path.join(base, 'outside.js'), path.join(root, 'index.js'));
		const codes = (await scanCandidateSource({ root, entries: ['index.js'] })).reasons.map((reason) => reason.code);
		expect(codes).not.toContain('uses-raw-fs');
		expect(codes).toContain('local-path-escapes-root');
	});

	it('refuses an escaping declared entry even when a sibling entry resolves inside the root', async () => {
		const base = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(base);
		const root = path.join(base, 'pkg');
		await mkdir(root);
		await writeFile(path.join(base, 'outside.js'), 'export default {};\n');
		await symlink(path.join(base, 'outside.js'), path.join(root, 'escaping.js'));
		await writeFile(path.join(root, 'index.js'), 'export default {};\n');
		const { reasons } = await scanCandidateSource({ root, entries: ['index.js', 'escaping.js'] });
		const codes = reasons.map((reason) => reason.code);
		expect(codes).toContain('local-path-escapes-root');
		expect(reasons.find((reason) => reason.code === 'local-path-escapes-root')?.message).not.toContain('outside');
	});

	it('refuses a local import that symlinks outside the package root without following it', async () => {
		const base = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(base);
		const root = path.join(base, 'pkg');
		await mkdir(root);
		await writeFile(path.join(base, 'outside.js'), "import { readFile } from 'node:fs/promises';\n");
		await writeFile(path.join(root, 'index.js'), "import './link.js';\nexport default {};\n");
		await symlink(path.join(base, 'outside.js'), path.join(root, 'link.js'));
		const { reasons } = await scanCandidateSource({ root, entries: ['index.js'] });
		const codes = reasons.map((reason) => reason.code);
		expect(codes).not.toContain('uses-raw-fs');
		expect(codes).toContain('local-path-escapes-root');
		expect(reasons.find((reason) => reason.code === 'local-path-escapes-root')?.message).toContain('index.js');
	});

	it('treats an unresolvable local import as a non-event', async () => {
		const codes = await scan("import './missing.js';\nexport default {};\n");
		expect(codes).toHaveLength(0);
	});

	it('refuses a source file over the per-file cap during the read', async () => {
		const oversized = `// ${'x'.repeat(MAX_SOURCE_FILE_BYTES)}\n`;
		const codes = await scan(oversized);
		expect(codes).toContain('source-too-large');
	});

	it('refuses a graph over the file-count cap', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(dir);
		const count = MAX_SOURCE_FILE_COUNT;
		const imports = Array.from({ length: count }, (_, index) => `import './f${index}.js';`).join('\n');
		await writeFile(path.join(dir, 'index.js'), `${imports}\nexport default {};\n`);

		await Promise.all(
			Array.from({ length: count }, (_, index) => writeFile(path.join(dir, `f${index}.js`), 'export default {};\n'))
		);

		const { reasons } = await scanCandidateSource({ root: dir, entries: ['index.js'] });
		expect(reasons.map((reason) => reason.code)).toContain('source-too-large');
	});

	it('refuses a graph over the total-bytes cap', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(dir);
		const count = Math.ceil(MAX_SOURCE_GRAPH_BYTES / MAX_SOURCE_FILE_BYTES) + 1;
		const filler = `// ${'x'.repeat(MAX_SOURCE_FILE_BYTES - 4)}\n`;
		const imports = Array.from({ length: count }, (_, index) => `import './f${index}.js';`).join('\n');
		await writeFile(path.join(dir, 'index.js'), `${imports}\nexport default {};\n`);

		await Promise.all(Array.from({ length: count }, (_, index) => writeFile(path.join(dir, `f${index}.js`), filler)));

		const { reasons } = await scanCandidateSource({ root: dir, entries: ['index.js'] });
		expect(reasons.map((reason) => reason.code)).toContain('source-too-large');
	});

	it.skipIf(process.getuid?.() === 0)('refuses a resolved entry that cannot be read', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(dir);
		const file = path.join(dir, 'index.js');
		await writeFile(file, 'export default {};\n');
		await chmod(file, 0o000);

		const { reasons } = await scanCandidateSource({ root: dir, entries: ['index.js'] });
		expect(reasons.map((reason) => reason.code)).toContain('source-read-failed');
	});

	it('maps an unreadable resolved file to source-read-failed through the read seam', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(dir);
		await writeFile(path.join(dir, 'index.js'), 'export default {};\n');

		const { reasons } = await scanCandidateSource(
			{ root: dir, entries: ['index.js'] },
			{ readFile: async () => ({ ok: false, reason: 'unreadable' }) }
		);

		expect(reasons.map((reason) => reason.code)).toContain('source-read-failed');
	});

	it('refuses a file whose relative imports exceed the resolution-attempt cap', async () => {
		const dir = await mkdtemp(path.join(os.tmpdir(), 'cairn-scan-'));
		created.push(dir);
		const count = MAX_SOURCE_IMPORT_ATTEMPTS + 1;
		const imports = Array.from({ length: count }, (_, index) => `import './m${index}.js';`).join('\n');
		await writeFile(path.join(dir, 'index.js'), `${imports}\nexport default {};\n`);

		const { reasons } = await scanCandidateSource({ root: dir, entries: ['index.js'] });
		expect(reasons.map((reason) => reason.code)).toContain('source-too-large');
	}, 15_000);
});
