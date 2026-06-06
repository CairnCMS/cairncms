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
