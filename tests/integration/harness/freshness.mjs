import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { compiledArtifacts } from './artifacts.mjs';

const exec = promisify(execFile);

export const buildFilters = ['--filter', '@cairncms/api...', '--filter', '@cairncms/sdk...'];
export const hash = (data) => createHash('sha256').update(data).digest('hex');

const instruction = 'Run pnpm test:integration:prepare, then retry.';

async function workspacePackages(root) {
	let stdout;

	try {
		({ stdout } = await exec('pnpm', ['--recursive', ...buildFilters, 'list', '--depth', '-1', '--json'], {
			cwd: root,
			maxBuffer: 4 * 1024 * 1024,
		}));
	} catch (error) {
		throw new Error(`Could not read pnpm build graph (${error.code}). ${instruction}`);
	}

	const packages = JSON.parse(stdout).map(({ name, path }) => ({ name, path: relative(root, path) }));
	if (
		!packages.some(({ name }) => name === '@cairncms/api') ||
		!packages.some(({ name }) => name === '@cairncms/sdk') ||
		packages.some(({ path }) => !path || path.startsWith('..') || isAbsolute(path))
	)
		throw new Error(`Invalid pnpm build graph. ${instruction}`);
	return packages.sort((a, b) => a.path.localeCompare(b.path));
}

async function files(root, directory, accept, hashes) {
	for (const entry of (await readdir(join(root, directory), { withFileTypes: true })).sort((a, b) =>
		a.name.localeCompare(b.name)
	)) {
		const path = join(directory, entry.name);
		if (!accept(path)) continue;
		const info = entry.isSymbolicLink() ? await stat(join(root, path)) : entry;
		if (info.isDirectory()) await files(root, path, accept, hashes);
		else if (info.isFile()) hashes[path] = hash(await readFile(join(root, path)));
	}
}

export async function buildInputs(root) {
	const packages = await workspacePackages(root);
	const inputs = {};

	for (const entry of await readdir(root)) {
		if (
			['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs'].includes(entry) ||
			/^tsconfig.*\.json$/.test(entry)
		)
			inputs[entry] = hash(await readFile(join(root, entry)));
	}

	for (const required of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'])
		if (!inputs[required]) throw new Error(`Missing build input ${required}. ${instruction}`);

	for (const path of ['node_modules/.pnpm/lock.yaml', 'node_modules/.modules.yaml']) {
		try {
			inputs[path] = hash(await readFile(join(root, path)));
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}

	for (const pkg of packages) {
		await files(
			root,
			pkg.path,
			(path) => {
				const parts = relative(pkg.path, path).split('/');
				return (
					!parts.some((part) =>
						['node_modules', '.git', '.artifacts', 'coverage', '__tests__', '__fixtures__'].includes(part)
					) &&
					!['dist', 'tests', 'test', 'docs', '.vite'].includes(parts[0]) &&
					!(parts.length === 1 && /^(readme|changelog|license)(\.|$)/i.test(parts[0])) &&
					!/\.(test|spec)\.[cm]?[jt]sx?$|\.tsbuildinfo$/.test(path)
				);
			},
			inputs
		);
	}

	try {
		await files(root, 'patches', () => true, inputs);
	} catch (error) {
		if (error.code !== 'ENOENT') throw error;
	}

	return { node: process.version, packages, inputs: Object.fromEntries(Object.entries(inputs).sort()) };
}

export async function buildArtifacts(root, packages) {
	const artifacts = await compiledArtifacts(root);

	for (const pkg of packages) {
		try {
			await files(root, join(pkg.path, 'dist'), () => true, artifacts);
		} catch (error) {
			throw new Error(`Compiled output ${pkg.path}/dist is unavailable (${error.code}). ${instruction}`);
		}
	}

	return Object.fromEntries(Object.entries(artifacts).sort());
}

export function assertSameInputs(before, after) {
	if (JSON.stringify(before) !== JSON.stringify(after))
		throw new Error(`Build inputs changed during preparation; no successful record was written. ${instruction}`);
}

export async function verifyPreparation(root) {
	let prepared;

	try {
		prepared = JSON.parse(await readFile(join(root, 'tests/integration/.artifacts/prepared.json'), 'utf8'));
	} catch {
		throw new Error(`Missing or invalid preparation record. ${instruction}`);
	}

	if (prepared?.format !== 1 || !prepared.buildInputs || !prepared.artifacts)
		throw new Error(`Unsupported preparation record. ${instruction}`);
	const inputs = await buildInputs(root);
	if (JSON.stringify(prepared.buildInputs) !== JSON.stringify(inputs))
		throw new Error(
			`Stale compiled build: source, workspace dependencies or build configuration changed. ${instruction}`
		);
	const artifacts = await buildArtifacts(root, inputs.packages);
	if (JSON.stringify(prepared.artifacts) !== JSON.stringify(artifacts))
		throw new Error(`Stale compiled build: build artifacts changed. ${instruction}`);
	return { prepared, artifacts };
}
