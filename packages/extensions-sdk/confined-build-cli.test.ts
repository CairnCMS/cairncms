import { execa } from 'execa';
import fse from 'fs-extra';
import { resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';

const testPrefix = 'temp-confined';

afterAll(async () => {
	const testArtifacts = (await fse.readdir(process.cwd())).filter((file) => file.startsWith(testPrefix));

	for (const tempArtifact of testArtifacts) {
		await fse.remove(tempArtifact);
	}
});

function evalGlobal(code: string, globalName = 'CairnOperation'): { default: { id: string; handler: unknown } } {
	return new Function(`${code}\nreturn ${globalName};`)();
}

async function writeConfinedOperation(name: string): Promise<string> {
	await fse.outputJSON(resolve(name, 'package.json'), {
		name,
		version: '1.0.0',
		type: 'module',
		'cairncms:extension': {
			type: 'operation',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			source: { app: 'src/app.js', api: 'src/api.js' },
			runtime: 'confined-server',
			capabilities: { log: true },
			host: '^10.0.0',
		},
	});

	await fse.outputFile(
		resolve(name, 'src', 'api.js'),
		`export default { id: '${name}', handler: async () => ({ ok: true }) };\n`
	);

	await fse.outputFile(
		resolve(name, 'src', 'app.js'),
		`export default { id: '${name}', name: 'Temp', icon: 'star', overview: () => [], options: [] };\n`
	);

	return name;
}

test('the manifest-driven build produces the confined artifact beside the app bundle', async () => {
	const dir = await writeConfinedOperation(`${testPrefix}-operation-${Date.now()}`);

	await execa('node', ['../cli.js', 'build'], { cwd: dir });

	const artifact = await fse.readFile(resolve(dir, 'dist', 'api.js'), 'utf8');
	expect(artifact).toContain('var CairnOperation');
	expect(evalGlobal(artifact).default.id).toBe(dir);
	expect(typeof evalGlobal(artifact).default.handler).toBe('function');

	expect(await fse.pathExists(resolve(dir, 'dist', 'app.js'))).toBe(true);
}, 30_000);

test('explicit entrypoint arguments refuse inside a confined-declared package', async () => {
	const dir = await writeConfinedOperation(`${testPrefix}-explicit-${Date.now()}`);

	const result = await execa(
		'node',
		[
			'../cli.js',
			'build',
			'-t',
			'operation',
			'-i',
			'{"app":"src/app.js","api":"src/api.js"}',
			'-o',
			'{"app":"dist/app.js","api":"dist/api.js"}',
		],
		{ cwd: dir, reject: false }
	);

	expect(result.exitCode).toBe(1);
	expect(`${result.stdout}${result.stderr}`).toContain('manifest');
	expect(await fse.pathExists(resolve(dir, 'dist'))).toBe(false);
}, 30_000);

test('the manifest-driven build produces a confined endpoint artifact under its contract global', async () => {
	const dir = `${testPrefix}-endpoint-${Date.now()}`;

	await fse.outputJSON(resolve(dir, 'package.json'), {
		name: dir,
		version: '1.0.0',
		type: 'module',
		'cairncms:extension': {
			type: 'endpoint',
			path: 'dist/index.js',
			source: 'src/index.js',
			runtime: 'confined-server',
			capabilities: { log: true, endpoint: { access: 'authenticated' } },
			host: '^10.0.0',
		},
	});

	await fse.outputFile(
		resolve(dir, 'src', 'index.js'),
		`export default { id: '${dir}', handler: async () => ({ body: null }) };\n`
	);

	await execa('node', ['../cli.js', 'build'], { cwd: dir });

	const artifact = await fse.readFile(resolve(dir, 'dist', 'index.js'), 'utf8');
	expect(artifact).toContain('var CairnEndpoint');
	expect(artifact).not.toContain('var CairnOperation');
	expect(evalGlobal(artifact, 'CairnEndpoint').default.id).toBe(dir);
	expect(typeof evalGlobal(artifact, 'CairnEndpoint').default.handler).toBe('function');
}, 30_000);

test('the manifest-driven build produces a confined hook artifact under its contract global', async () => {
	const dir = `${testPrefix}-hook-${Date.now()}`;

	await fse.outputJSON(resolve(dir, 'package.json'), {
		name: dir,
		version: '1.0.0',
		type: 'module',
		'cairncms:extension': {
			type: 'hook',
			path: 'dist/index.js',
			source: 'src/index.js',
			runtime: 'confined-server',
			capabilities: { log: true },
			events: { action: ['items.create'] },
			host: '^10.0.0',
		},
	});

	await fse.outputFile(
		resolve(dir, 'src', 'index.js'),
		`export default { id: '${dir}', actions: { 'items.create': async () => undefined } };\n`
	);

	await execa('node', ['../cli.js', 'build'], { cwd: dir });

	const artifact = await fse.readFile(resolve(dir, 'dist', 'index.js'), 'utf8');
	expect(artifact).toContain('var CairnHook');
	expect(artifact).not.toContain('var CairnOperation');
	expect(evalGlobal(artifact, 'CairnHook').default.id).toBe(dir);
}, 30_000);

test('a confined type without a runtime contract refuses by name', async () => {
	const dir = `${testPrefix}-bundle-${Date.now()}`;

	await fse.outputJSON(resolve(dir, 'package.json'), {
		name: dir,
		version: '1.0.0',
		type: 'module',
		'cairncms:extension': {
			type: 'bundle',
			path: { app: 'dist/app.js', api: 'dist/api.js' },
			entries: [{ type: 'endpoint', name: 'inner', source: 'src/inner.js' }],
			runtime: 'confined-server',
			host: '^10.0.0',
		},
	});

	await fse.outputFile(resolve(dir, 'src', 'inner.js'), 'export default () => {};\n');

	const result = await execa('node', ['../cli.js', 'build'], { cwd: dir, reject: false });

	expect(result.exitCode).toBe(1);
	expect(`${result.stdout}${result.stderr}`).toContain('bundle');
	expect(await fse.pathExists(resolve(dir, 'dist'))).toBe(false);
}, 30_000);
