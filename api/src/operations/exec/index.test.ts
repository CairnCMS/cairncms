import { describe, expect, it } from 'vitest';
import config from './index.js';

const DEFAULT_LIMITS = {
	FLOWS_RUN_SCRIPT_MAX_MEMORY: 8,
	FLOWS_RUN_SCRIPT_TIMEOUT: 10000,
};

function callHandler(
	code: string,
	options: {
		data?: Record<string, unknown>;
		env?: Record<string, unknown>;
		logger?: unknown;
	} = {}
) {
	return config.handler({ code }, {
		data: options.data ?? {},
		env: options.env ?? DEFAULT_LIMITS,
		logger: options.logger,
	} as any);
}

function makeLogger() {
	const calls: Array<{ method: string; arg: unknown }> = [];

	const record =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, arg: args.length === 1 ? args[0] : args });
		};

	const logger = {
		log: record('log'),
		info: record('info'),
		warn: record('warn'),
		error: record('error'),
		trace: record('trace'),
		debug: record('debug'),
	};

	return { logger, calls };
}

describe('exec — sandbox enforcement', () => {
	it('aborts when the isolate exceeds its memory limit', async () => {
		const code = `
			const buckets = [];
			const chunkSize = 1 << 21; // 2 MiB
			while (true) {
				const chunk = new Uint8Array(chunkSize);
				for (let i = 0; i < chunkSize; i += 4096) chunk[i] = 0xff;
				buckets.push(chunk);
			}
		`;

		await expect(callHandler(code)).rejects.toThrow(/allocation failed/i);
	});

	it('aborts a synchronous script that runs past the configured timeout', async () => {
		const code = 'for (;;) {}';

		await expect(callHandler(code, { env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_TIMEOUT: 250 } })).rejects.toThrow(
			/timed out/i
		);
	});

	it('aborts an exported handler that loops forever', async () => {
		const code = `
			module.exports = async function () {
				let n = 0;
				while (true) {
					n += 1;
				}
			};
		`;

		await expect(callHandler(code, { env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_TIMEOUT: 250 } })).rejects.toThrow(
			/timed out/i
		);
	});

	it('rejects calls to the CommonJS require', async () => {
		await expect(callHandler(`require('node:fs');`)).rejects.toThrow(/require is not defined/);
	});

	it('rejects ESM import statements', async () => {
		await expect(callHandler(`import 'node:fs';`)).rejects.toThrow(/import statement outside a module/);
	});
});

describe('exec — error propagation', () => {
	it('surfaces syntax errors from the user script', async () => {
		await expect(callHandler(`module.exports = function() { return ;;`)).rejects.toThrow(SyntaxError);
	});

	it('surfaces reference errors when the script touches an undefined identifier', async () => {
		const code = `module.exports = function () { return undefinedThing; };`;

		await expect(callHandler(code)).rejects.toThrow(/undefinedThing is not defined/);
	});

	it('rejects when module.exports is not a function', async () => {
		await expect(callHandler(`module.exports = 42;`)).rejects.toThrow(/not a function/);
	});

	it('preserves the message of a user-thrown error', async () => {
		const code = `
			module.exports = function () {
				throw new Error('intentional failure for the test');
			};
		`;

		await expect(callHandler(code)).rejects.toThrow('intentional failure for the test');
	});
});

describe('exec — successful execution', () => {
	it('returns the value from a synchronous handler', async () => {
		const code = `module.exports = function (data) { return { doubled: data.input * 2 }; };`;

		await expect(callHandler(code, { data: { input: 21 } })).resolves.toEqual({ doubled: 42 });
	});

	it('returns the value from an asynchronous handler', async () => {
		const code = `
			module.exports = async function (data) {
				return { upper: data.text.toUpperCase() };
			};
		`;

		await expect(callHandler(code, { data: { text: 'cairn' } })).resolves.toEqual({ upper: 'CAIRN' });
	});

	it('passes deeply nested data through unchanged', async () => {
		const code = `module.exports = (data) => data;`;
		const payload = { a: 1, b: { c: [2, 3, { d: true, e: null }] } };

		await expect(callHandler(code, { data: payload })).resolves.toEqual(payload);
	});
});

describe('exec — data and environment', () => {
	it('exposes data.$env to the user script via process.env', async () => {
		const code = `module.exports = () => ({ token: process.env.TOKEN, lang: process.env.LANG });`;

		await expect(callHandler(code, { data: { $env: { TOKEN: 'secret-value', LANG: 'en' } } })).resolves.toEqual({
			token: 'secret-value',
			lang: 'en',
		});
	});

	it('strips functions from the data payload before crossing the isolate boundary', async () => {
		const code = `
			module.exports = function (data) {
				return {
					valueType: typeof data.value,
					value: data.value,
					callbackType: typeof data.callback,
					nestedFnType: typeof data.nested.callback,
				};
			};
		`;

		const dataWithFunctions = {
			value: 'kept',
			callback: () => 1,
			nested: { callback: () => 2 },
		};

		await expect(callHandler(code, { data: dataWithFunctions as any })).resolves.toEqual({
			valueType: 'string',
			value: 'kept',
			callbackType: 'undefined',
			nestedFnType: 'undefined',
		});
	});

	it('handles a circular data payload without crashing the helper or the boundary', async () => {
		const code = `
			module.exports = function (data) {
				return { name: data.name, cyclePreserved: data.self === data };
			};
		`;

		type Cyclic = { name: string; self?: Cyclic };
		const cyclic: Cyclic = { name: 'root' };
		cyclic.self = cyclic;

		await expect(callHandler(code, { data: cyclic as any })).resolves.toEqual({
			name: 'root',
			cyclePreserved: true,
		});
	});
});

describe('exec — console bridge', () => {
	it('routes console.log to logger.info and other methods to their matching channels', async () => {
		const { logger, calls } = makeLogger();

		const code = `
			module.exports = function () {
				console.log('routed-log');
				console.info('routed-info');
				console.warn('routed-warn');
				console.error('routed-error');
				console.trace('routed-trace');
				console.debug('routed-debug');
				return null;
			};
		`;

		await callHandler(code, { logger });

		expect(calls).toEqual([
			{ method: 'info', arg: 'routed-log' },
			{ method: 'info', arg: 'routed-info' },
			{ method: 'warn', arg: 'routed-warn' },
			{ method: 'error', arg: 'routed-error' },
			{ method: 'trace', arg: 'routed-trace' },
			{ method: 'debug', arg: 'routed-debug' },
		]);
	});

	it('unpacks a single argument but packs multiple arguments into an array', async () => {
		const { logger, calls } = makeLogger();

		const code = `
			module.exports = function () {
				console.log('only');
				console.log('first', 'second', 'third');
				return null;
			};
		`;

		await callHandler(code, { logger });

		expect(calls).toEqual([
			{ method: 'info', arg: 'only' },
			{ method: 'info', arg: ['first', 'second', 'third'] },
		]);
	});
});

describe('exec — configuration validation', () => {
	it('rejects when FLOWS_RUN_SCRIPT_MAX_MEMORY is not a number', async () => {
		const code = `module.exports = () => null;`;

		await expect(
			callHandler(code, { env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_MAX_MEMORY: 'oops' } })
		).rejects.toThrow(/memoryLimit.*must be a number/);
	});

	it('rejects when FLOWS_RUN_SCRIPT_TIMEOUT is not a number', async () => {
		const code = `module.exports = () => null;`;

		await expect(callHandler(code, { env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_TIMEOUT: 'oops' } })).rejects.toThrow(
			/timeout.*must be a 32-bit number/
		);
	});
});
