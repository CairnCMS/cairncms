import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { envState, watchSpy } = vi.hoisted(() => ({
	envState: { EXTENSIONS_PATH: './extensions', SERVE_APP: false } as Record<string, unknown>,
	watchSpy: vi.fn(),
}));

vi.mock('./env.js', () => ({ default: envState, getEnv: () => envState, refreshEnv: () => undefined }));

vi.mock('chokidar', () => ({ default: { watch: watchSpy }, watch: watchSpy }));

import { ExtensionManager } from './extensions.js';

let handlers: Record<string, (...args: any[]) => void>;
let watcher: { on: any; close: any; add: any; unwatch: any };

beforeEach(() => {
	handlers = {};

	watcher = {
		on: vi.fn((event: string, handler: (...args: any[]) => void) => {
			handlers[event] = handler;
			return watcher;
		}),
		close: vi.fn().mockResolvedValue(undefined),
		add: vi.fn(),
		unwatch: vi.fn(),
	};

	watchSpy.mockReset();
	watchSpy.mockReturnValue(watcher);
});

function initWatcher(): ExtensionManager {
	const manager = new ExtensionManager();
	(manager as any).initializeWatcher();
	return manager;
}

describe('extension watcher initial path scoping', () => {
	it('with SERVE_APP off, watches server-relevant entrypoints only', () => {
		envState.SERVE_APP = false;
		initWatcher();
		const paths = watchSpy.mock.calls[0]![0] as string[];

		expect(paths.some((p) => p.includes('/endpoints/'))).toBe(true);
		expect(paths.some((p) => p.includes('/hooks/'))).toBe(true);
		expect(paths.some((p) => p.includes('/interfaces/'))).toBe(false);
		expect(paths.some((p) => p.includes('/operations/') && p.includes('api.'))).toBe(true);
		expect(paths.some((p) => p.includes('/operations/') && p.includes('app.'))).toBe(false);
	});

	it('with SERVE_APP on, also watches app entrypoints', () => {
		envState.SERVE_APP = true;
		initWatcher();
		const paths = watchSpy.mock.calls[0]![0] as string[];

		expect(paths.some((p) => p.includes('/interfaces/'))).toBe(true);
		expect(paths.some((p) => p.includes('/operations/') && p.includes('app.'))).toBe(true);
	});

	it('configures awaitWriteFinish so partial writes do not reload', () => {
		initWatcher();
		const options = watchSpy.mock.calls[0]![1] as Record<string, unknown>;

		expect(options['awaitWriteFinish']).toBeDefined();
	});
});

describe('extension watcher dynamic path scoping', () => {
	const bundle = {
		type: 'bundle',
		local: true,
		path: '/ext/cairncms-extension-b',
		entrypoint: { app: 'dist/app.js', api: 'dist/api.js' },
	};

	it('with SERVE_APP off, adds only the API entrypoint of a bundle', () => {
		envState.SERVE_APP = false;
		const manager = initWatcher();
		(manager as any).updateWatchedExtensions([bundle], []);
		const added = watcher.add.mock.calls[0]![0] as string[];

		expect(added.some((p) => p.endsWith('api.js'))).toBe(true);
		expect(added.some((p) => p.endsWith('app.js'))).toBe(false);
	});

	it('with SERVE_APP on, adds both app and API entrypoints of a bundle', () => {
		envState.SERVE_APP = true;
		const manager = initWatcher();
		(manager as any).updateWatchedExtensions([bundle], []);
		const added = watcher.add.mock.calls[0]![0] as string[];

		expect(added.some((p) => p.endsWith('api.js'))).toBe(true);
		expect(added.some((p) => p.endsWith('app.js'))).toBe(true);
	});

	it('adds the API entrypoint of a local package-style operation', () => {
		// Package-style local extensions build into dist paths the nested-layout
		// globs never match, so the watcher must track them per-extension or the
		// dev loop loses rebuild reloads.
		envState.SERVE_APP = false;
		const manager = initWatcher();

		(manager as any).updateWatchedExtensions(
			[
				{
					type: 'operation',
					local: true,
					path: '/ext/cairncms-extension-op',
					entrypoint: { app: 'dist/app.js', api: 'dist/api.js' },
				},
			],
			[]
		);

		const added = watcher.add.mock.calls[0]![0] as string[];

		expect(added.some((p) => p.endsWith('cairncms-extension-op/dist/api.js'))).toBe(true);
		expect(added.some((p) => p.endsWith('app.js'))).toBe(false);
	});

	it('keeps app-type extensions unwatched while the app is not served', () => {
		envState.SERVE_APP = false;
		const manager = initWatcher();

		(manager as any).updateWatchedExtensions(
			[{ type: 'interface', local: true, path: '/ext/cairncms-extension-ui', entrypoint: 'dist/index.js' }],
			[]
		);

		const added = watcher.add.mock.calls[0]![0] as string[];
		expect(added).toHaveLength(0);
	});

	it('never dynamically manages nested-layout locals the initial globs own', () => {
		// An unwatch of a glob-covered path suppresses it in chokidar even though
		// the glob still matches, so a nested local that was removed and re-added
		// would permanently lose its reloads if it were managed per-extension.
		envState.SERVE_APP = false;
		const manager = initWatcher();

		const nested = {
			type: 'endpoint',
			local: true,
			path: resolve('./extensions', 'endpoints', 'my-ep'),
			entrypoint: 'index.js',
		};

		(manager as any).updateWatchedExtensions([nested], []);
		expect((watcher.add.mock.calls[0]![0] as string[]).length).toBe(0);

		(manager as any).updateWatchedExtensions([], [nested]);
		expect((watcher.unwatch.mock.calls[1]![0] as string[]).length).toBe(0);
	});

	it('unwatches a removed package-style local extension', () => {
		envState.SERVE_APP = false;
		const manager = initWatcher();

		const packaged = {
			type: 'operation',
			local: true,
			path: '/ext/cairncms-extension-op',
			entrypoint: { app: 'dist/app.js', api: 'dist/api.js' },
		};

		(manager as any).updateWatchedExtensions([], [packaged]);

		const unwatched = watcher.unwatch.mock.calls[0]![0] as string[];
		expect(unwatched.some((p) => p.endsWith('cairncms-extension-op/dist/api.js'))).toBe(true);
	});
});

describe('extension watcher reload wiring', () => {
	afterEach(() => vi.useRealTimers());

	it('debounces a burst of change events from the watcher into one reload', () => {
		const manager = new ExtensionManager();
		const reloadSpy = vi.spyOn(manager, 'reload').mockImplementation(() => undefined);

		vi.useFakeTimers();
		(manager as any).initializeWatcher();
		handlers['change']!();
		handlers['change']!();
		handlers['change']!();
		vi.advanceTimersByTime(250);

		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it('closeWatcher cancels a pending reload', async () => {
		const manager = new ExtensionManager();
		const reloadSpy = vi.spyOn(manager, 'reload').mockImplementation(() => undefined);

		vi.useFakeTimers();
		(manager as any).initializeWatcher();
		handlers['change']!();
		await (manager as any).closeWatcher();
		vi.advanceTimersByTime(250);

		expect(reloadSpy).not.toHaveBeenCalled();
	});
});
