import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { REDACT_TEXT } from '../../constants.js';
import { InvalidConfigException } from '../../exceptions/index.js';
import config from './index.js';

const DEFAULT_LIMITS = {
	FLOWS_RUN_SCRIPT_MAX_MEMORY: 8,
	FLOWS_RUN_SCRIPT_TIMEOUT: 10000,
};

const identityRedactor = (value: unknown) => value;

function callHandler(
	code: string,
	options: {
		data?: Record<string, unknown>;
		env?: Record<string, unknown>;
		logger?: unknown;
		redactForFlowLog?: (value: unknown) => unknown;
	} = {}
) {
	return config.handler({ code }, {
		data: options.data ?? {},
		env: options.env ?? DEFAULT_LIMITS,
		logger: options.logger,
		redactForFlowLog: options.redactForFlowLog,
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

	it('aborts an exported handler whose returned promise never settles', { timeout: 5000 }, async () => {
		const code = 'module.exports = () => new Promise(() => {});';

		await expect(callHandler(code, { env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_TIMEOUT: 250 } })).rejects.toThrow(
			/timed out/i
		);
	});

	it('times out before evaluation when the budget is already spent', async () => {
		const now = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(10_000);

		try {
			await expect(callHandler('module.exports = () => 1;')).rejects.toThrow(/timed out/i);
		} finally {
			now.mockRestore();
		}
	});

	it('rejects calls to the CommonJS require', async () => {
		await expect(callHandler(`require('node:fs');`)).rejects.toThrow(/require is not defined/);
	});

	it('rejects ESM import statements', async () => {
		await expect(callHandler(`import 'node:fs';`)).rejects.toThrow(/import statement outside a module/);
	});
});

function runNeverSettlingChild(): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const childTs = fileURLToPath(new URL('./__fixtures__/never-settling-child.ts', import.meta.url));

	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ['--no-node-snapshot', '--import', 'tsx', childTs], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { PATH: process.env['PATH'] },
		});

		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk) => (stdout += chunk));
		child.stderr.on('data', (chunk) => (stderr += chunk));

		const watchdog = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`the child produced no report before the watchdog fired\n${stderr}`));
		}, 20_000);

		child.on('error', (error) => {
			clearTimeout(watchdog);
			reject(error);
		});

		child.on('close', (code) => {
			clearTimeout(watchdog);
			resolve({ code, stdout, stderr });
		});
	});
}

describe('exec: isolate release', () => {
	it('disposes the isolate of every never-settling invocation it times out', { timeout: 30_000 }, async () => {
		const run = await runNeverSettlingChild();
		expect(run.code, run.stderr).toBe(0);

		const output = run.stdout.trim();
		expect(output, run.stderr).not.toBe('');

		const report = JSON.parse(output.split('\n').pop()!);

		expect(report.results).toHaveLength(3);

		for (const result of report.results) {
			expect(result.outcome).toBe('rejected');
			expect(result.message).toMatch(/timed out/i);
			expect(result.elapsedMs).toBeLessThan(2000);
		}

		expect(report.disposed).toEqual([true, true, true]);
		expect(report.unhandled).toEqual([]);
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

		await callHandler(code, { logger, redactForFlowLog: identityRedactor });

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

		await callHandler(code, { logger, redactForFlowLog: identityRedactor });

		expect(calls).toEqual([
			{ method: 'info', arg: 'only' },
			{ method: 'info', arg: ['first', 'second', 'third'] },
		]);
	});

	it('redacts console output through the supplied redactor', async () => {
		const { logger, calls } = makeLogger();
		const redactForFlowLog = (value: unknown) => (value === 'longsecretvalue123' ? REDACT_TEXT : value);

		const code = `module.exports = function () { console.log('longsecretvalue123'); return null; };`;

		await callHandler(code, { logger, redactForFlowLog });

		expect(calls).toEqual([{ method: 'info', arg: REDACT_TEXT }]);
	});

	it('fails closed: with no redactor supplied, console output is fully redacted', async () => {
		const { logger, calls } = makeLogger();

		const code = `module.exports = function () { console.log('would-be-secret-output'); return null; };`;

		await callHandler(code, { logger });

		expect(calls).toEqual([{ method: 'info', arg: REDACT_TEXT }]);
	});
});

describe('exec — configuration validation', () => {
	it('rejects when FLOWS_RUN_SCRIPT_MAX_MEMORY is not a number', async () => {
		const code = `module.exports = () => null;`;

		await expect(
			callHandler(code, { env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_MAX_MEMORY: 'oops' } })
		).rejects.toThrow(/memoryLimit.*must be a number/);
	});

	it.each([0, -1, 250.5, 2_147_483_648, 'oops'])(
		'rejects a FLOWS_RUN_SCRIPT_TIMEOUT of %s as invalid config',
		async (value) => {
			const result = callHandler(`module.exports = () => null;`, {
				env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_TIMEOUT: value },
			});

			await expect(result).rejects.toBeInstanceOf(InvalidConfigException);
			await expect(result).rejects.toThrow(/FLOWS_RUN_SCRIPT_TIMEOUT/);
		}
	);

	it('accepts the largest FLOWS_RUN_SCRIPT_TIMEOUT a timer can hold', async () => {
		const code = `module.exports = () => 'done';`;

		await expect(
			callHandler(code, { env: { ...DEFAULT_LIMITS, FLOWS_RUN_SCRIPT_TIMEOUT: 2_147_483_647 } })
		).resolves.toBe('done');
	});
});
