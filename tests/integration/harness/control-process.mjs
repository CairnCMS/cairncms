import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const integrationRoot = fileURLToPath(new URL('../', import.meta.url));
export const docker = promisify(execFile);

export function startControl(args, options = {}) {
	const child = spawn(process.execPath, args, {
		cwd: integrationRoot,
		stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
		...options,
		env: { ...process.env, CI: 'false', ...options.env },
	});

	let output = '';
	for (const stream of [child.stdout, child.stderr])
		stream.on('data', (chunk) => {
			output += chunk;
		});

	const done = new Promise((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', resolve);
	});

	return {
		child,
		done,
		output: () => output,
		async poll(condition, timeout = 90000) {
			const end = performance.now() + timeout;

			while (performance.now() < end) {
				if (await condition()) return;
				assert.equal(child.exitCode, null, output);
				assert.equal(child.signalCode, null, output);
				if (performance.now() >= end) break;
				await delay(25);
			}

			throw new Error(`Control condition timed out:\n${output}`);
		},
		async stop() {
			if (child.exitCode === null && child.signalCode === null) {
				child.kill('SIGTERM');
				const force = setTimeout(() => child.kill('SIGKILL'), 25000);

				try {
					await done;
				} finally {
					clearTimeout(force);
				}
			}
		},
	};
}

export async function owners(directory, suffix = '.owner.json') {
	const files = await readdir(directory).catch((error) => {
		if (error.code === 'ENOENT') return [];
		throw error;
	});

	return Promise.all(
		files
			.filter((file) => file.endsWith(suffix))
			.map((file) => readFile(join(directory, file), 'utf8').then(JSON.parse))
	);
}

export async function assertReleased(directory) {
	try {
		const pristine = JSON.parse(await readFile(join(directory, 'pristine.json'), 'utf8'));
		await assert.rejects(access(pristine.directory), { code: 'ENOENT' });
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}

	for (const owner of await owners(directory)) {
		await assert.rejects(access(owner.directory), { code: 'ENOENT' });
		for (const pid of owner.children ?? []) assert.throws(() => process.kill(pid, 0), /ESRCH/);
	}

	for (const owner of await owners(directory, '.service.json')) {
		const result = await docker('docker', [
			'ps',
			'-aq',
			'--filter',
			`label=cairncms.integration.service=${owner.serviceKey}`,
		]);

		assert.equal(result.stdout.trim(), '', 'Owned service container leaked');
	}

	try {
		const { id } = JSON.parse(await readFile(join(directory, 'container.json'), 'utf8'));
		const result = await docker('docker', ['ps', '-aq', '--filter', `id=${id}`]);
		assert.equal(result.stdout.trim(), '', 'Owned engine container leaked');
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}
}

// A disposable checkout lets the public CLI discover deliberate control failures
// without adding test-only switches to its selection or execution paths.
export async function controlCheckout(include, { copyApi = false } = {}) {
	const directory = await mkdtemp(join(tmpdir(), 'cairn-command-control-'));
	const root = join(directory, 'tests/integration');

	await cp(integrationRoot, root, {
		recursive: true,
		filter: (source) =>
			!source
				.slice(integrationRoot.length)
				.split('/')
				.some((part) => ['node_modules', '.artifacts'].includes(part)),
	});

	const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
	for (const relative of [
		'package.json',
		'pnpm-lock.yaml',
		'pnpm-workspace.yaml',
		'.npmrc',
		'node_modules',
		'sdk',
		'app',
		'packages',
		'tests/shared',
		...(await readdir(sourceRoot)).filter((name) => /^tsconfig.*\.json$/.test(name)),
	])
		await symlink(join(sourceRoot, relative), join(directory, relative));
	if (copyApi) {
		await mkdir(join(directory, 'api'));
		await cp(join(sourceRoot, 'api/dist'), join(directory, 'api/dist'), { recursive: true });
		for (const relative of ['package.json', 'node_modules'])
			await symlink(join(sourceRoot, 'api', relative), join(directory, 'api', relative));
		for (const relative of await readdir(join(sourceRoot, 'api')))
			if (!['dist', 'package.json', 'node_modules'].includes(relative))
				await symlink(join(sourceRoot, 'api', relative), join(directory, 'api', relative));
	} else await symlink(join(sourceRoot, 'api'), join(directory, 'api'));
	await mkdir(join(root, 'node_modules'));

	for (const name of await readdir(join(integrationRoot, 'node_modules'))) {
		if (name === '.vite' || name === '.vite-temp') continue;
		await symlink(join(integrationRoot, 'node_modules', name), join(root, 'node_modules', name));
	}

	const config = await readFile(join(root, 'vitest.config.ts'), 'utf8');
	assert(config.includes("include: ['**/*.test.ts']"));

	await writeFile(
		join(root, 'vitest.config.ts'),
		config
			.replace("include: ['**/*.test.ts']", `include: ${JSON.stringify(include)}`)
			.replace(
				"include: ['**/*.load.test.ts']",
				`include: ${JSON.stringify(include.filter((file) => file.endsWith('.load.test.ts')))}`
			)
	);

	await mkdir(join(root, '.artifacts'));
	await cp(join(integrationRoot, '.artifacts/prepared.json'), join(root, '.artifacts/prepared.json'));

	return { directory, root, remove: () => rm(directory, { recursive: true, force: true }) };
}
