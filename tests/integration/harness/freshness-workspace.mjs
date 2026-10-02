import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildInputs, buildArtifacts } from './freshness.mjs';

export async function seedBuildWorkspace(root) {
	const files = {
		'package.json': JSON.stringify({ private: true, packageManager: 'pnpm@10.13.1' }),
		'pnpm-workspace.yaml': 'packages:\n  - api\n  - sdk\n  - packages/*\n',
		'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
		'tsconfig.json': '{}',
		'api/package.json': JSON.stringify({
			name: '@cairncms/api',
			type: 'module',
			dependencies: { '@cairncms/example': 'workspace:*' },
			scripts: { build: 'node build.mjs' },
		}),
		'api/src/server.js': 'export const healthy = true;\n',
		'api/build.mjs': '',
		'api/dist/server.js': 'export const healthy = true;\n',
		'api/dist/cli/run.js': 'export {};',
		'api/dist/extensions/confined/runtime/child-host.mjs': 'export {};',
		'api/dist/extensions/confined/runtime/emscripten-module.wasm': 'fixture',
		'sdk/package.json': JSON.stringify({ name: '@cairncms/sdk', type: 'module', scripts: { build: 'node build.mjs' } }),
		'sdk/build.mjs': '',
		'sdk/src/index.ts': 'export {};',
		'sdk/dist/index.js': 'export {};',
		'packages/example/package.json': JSON.stringify({ name: '@cairncms/example', type: 'module' }),
		'packages/example/src/index.ts': 'export {};',
		'packages/example/dist/index.js': 'export {};',
	};

	for (const [file, contents] of Object.entries(files)) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), contents);
	}

	return files;
}

export async function recordBuildWorkspace(root) {
	const inputs = await buildInputs(root);

	const prepared = {
		format: 1,
		buildInputs: inputs,
		artifacts: await buildArtifacts(root, inputs.packages),
		preparedAt: 'control',
		revision: 'control',
	};

	await mkdir(join(root, 'tests/integration/.artifacts'), { recursive: true });
	await writeFile(join(root, 'tests/integration/.artifacts/prepared.json'), JSON.stringify(prepared));
}
