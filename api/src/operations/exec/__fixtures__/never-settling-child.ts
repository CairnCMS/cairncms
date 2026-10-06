import Module from 'node:module';

const TIMEOUT_MS = 200;
const RUNS = 3;
const LATE_REJECTION_WINDOW_MS = 100;

const isolates: Array<{ isDisposed: boolean }> = [];
const unhandled: string[] = [];

process.on('unhandledRejection', (reason) => {
	unhandled.push(String((reason as Error)?.message ?? reason));
});

const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown };
const originalLoad = loader._load;
let instrumented: object | undefined;

loader._load = function (this: unknown, request: string, ...rest: unknown[]) {
	const loaded = originalLoad.call(this, request, ...rest);
	if (request !== 'isolated-vm') return loaded;

	instrumented ??= new Proxy(loaded as object, {
		get(target, prop) {
			const value = Reflect.get(target, prop);
			if (prop !== 'Isolate') return value;

			return new Proxy(value, {
				construct(Isolate, args) {
					const isolate = Reflect.construct(Isolate, args);
					isolates.push(isolate);
					return isolate;
				},
			});
		},
	});

	return instrumented;
};

const { default: execOperation } = await import('../index.js');

const noop = () => undefined;
const keepAlive = setInterval(noop, 1000);
const results: Array<{ outcome: string; message?: string; elapsedMs: number }> = [];

for (let run = 0; run < RUNS; run++) {
	const started = performance.now();
	const elapsedMs = () => Math.round(performance.now() - started);

	try {
		await execOperation.handler({ code: 'module.exports = () => new Promise(() => {});' }, {
			data: {},
			env: { FLOWS_RUN_SCRIPT_TIMEOUT: TIMEOUT_MS, FLOWS_RUN_SCRIPT_MAX_MEMORY: 16 },
			logger: { info: noop, warn: noop, error: noop, trace: noop, debug: noop },
		} as never);

		results.push({ outcome: 'resolved', elapsedMs: elapsedMs() });
	} catch (error) {
		results.push({ outcome: 'rejected', message: (error as Error).message, elapsedMs: elapsedMs() });
	}
}

await new Promise((resolve) => setTimeout(resolve, LATE_REJECTION_WINDOW_MS));

clearInterval(keepAlive);

process.stdout.write(
	JSON.stringify({ results, disposed: isolates.map((isolate) => isolate.isDisposed), unhandled }) + '\n',
	() => process.exit(0)
);
