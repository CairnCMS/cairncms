import {
	APP_OR_HYBRID_EXTENSION_PACKAGE_TYPES,
	APP_OR_HYBRID_EXTENSION_TYPES,
	APP_SHARED_DEPS,
	NESTED_EXTENSION_TYPES,
} from '@cairncms/constants';
import {
	ensureExtensionDirs,
	generateExtensionsEntrypoint,
	getLocalExtensions,
	getPackageExtensions,
	redactErrorDetail,
	resolvePackageExtensions,
} from '@cairncms/utils/node';
import yaml from '@rollup/plugin-yaml';
import vue from '@vitejs/plugin-vue';
import path from 'node:path';
import { searchForWorkspaceRoot } from 'vite';
import { defineConfig } from 'vitest/config';
import { getExtensionRealPaths, isUnderExtensions } from './vite-extension-utils.js';

const API_PATH = path.join('..', 'api');
const EXTENSIONS_PATH = path.join(API_PATH, 'extensions');

export default defineConfig({
	plugins: [
		cairncmsExtensions(),
		vue(),
		yaml({
			transform(data) {
				return data === null ? {} : undefined;
			},
		}),
	],
	resolve: {
		alias: [
			{ find: '@', replacement: path.resolve(__dirname, 'src') },
			{ find: 'json2csv', replacement: 'json2csv/dist/json2csv.umd.js' },
		],
	},
	base: process.env.NODE_ENV === 'production' ? '' : '/admin/',
	server: {
		port: 8080,
		proxy: {
			'^/(?!admin)': {
				target: process.env.API_URL ? process.env.API_URL : 'http://127.0.0.1:8055/',
				changeOrigin: true,
			},
		},
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd()), ...getExtensionRealPaths(EXTENSIONS_PATH)],
		},
	},
	test: {
		environment: 'happy-dom',
		setupFiles: ['src/__setup__/mock-globals.ts'],
	},
});

function cairncmsExtensions() {
	const virtualExtensionsId = '@cairncms-extensions';

	let extensionsEntrypoint = null;

	return [
		{
			name: 'cairncms-extensions-serve',
			apply: 'serve',
			config: () => ({
				optimizeDeps: {
					include: APP_SHARED_DEPS,
				},
			}),
			async buildStart() {
				await loadExtensions();
			},
			configureServer(server) {
				let reloadTimer = null;

				const scheduleReload = () => {
					if (reloadTimer) clearTimeout(reloadTimer);

					reloadTimer = setTimeout(async () => {
						try {
							await loadExtensions();
						} catch (error) {
							server.config.logger.warn(`[cairncms] extension reload skipped: ${redactErrorDetail(error)}`);

							return;
						}

						const allow = server.config.server.fs.allow;

						for (const realPath of getExtensionRealPaths(EXTENSIONS_PATH)) {
							if (!allow.includes(realPath)) allow.push(realPath);
						}

						const module = server.moduleGraph.getModuleById(virtualExtensionsId);
						if (module) server.moduleGraph.invalidateModule(module);

						server.ws.send({ type: 'full-reload' });
					}, 150);
				};

				const extensionsRoot = path.resolve(EXTENSIONS_PATH);
				server.watcher.add(extensionsRoot);

				for (const event of ['add', 'addDir', 'unlink', 'unlinkDir']) {
					server.watcher.on(event, (changedPath) => {
						if (isUnderExtensions(extensionsRoot, changedPath)) scheduleReload();
					});
				}
			},
			resolveId(id) {
				if (id === virtualExtensionsId) {
					return id;
				}
			},
			load(id) {
				if (id === virtualExtensionsId) {
					return extensionsEntrypoint;
				}
			},
		},
		{
			name: 'cairncms-extensions-build',
			apply: 'build',
			config: () => ({
				build: {
					rollupOptions: {
						input: {
							index: path.resolve(__dirname, 'index.html'),
							...APP_SHARED_DEPS.reduce((acc, dep) => ({ ...acc, [dep.replace(/\//g, '_')]: dep }), {}),
						},
						output: {
							entryFileNames: 'assets/[name].[hash].entry.js',
						},
						external: [virtualExtensionsId],
						preserveEntrySignatures: 'exports-only',
					},
				},
			}),
		},
	];

	async function loadExtensions() {
		await ensureExtensionDirs(EXTENSIONS_PATH, NESTED_EXTENSION_TYPES);
		const packageExtensions = await getPackageExtensions(API_PATH, APP_OR_HYBRID_EXTENSION_PACKAGE_TYPES);
		const localPackageExtensions = await resolvePackageExtensions(EXTENSIONS_PATH);
		const localExtensions = await getLocalExtensions(EXTENSIONS_PATH, APP_OR_HYBRID_EXTENSION_TYPES);

		const extensions = [...packageExtensions, ...localPackageExtensions, ...localExtensions];

		extensionsEntrypoint = generateExtensionsEntrypoint(extensions);
	}
}
