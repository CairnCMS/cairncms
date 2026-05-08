import { defineOperationApi, stripFunctions } from '@cairncms/utils';
import { createRequire } from 'node:module';

const ivm = createRequire(import.meta.url)('isolated-vm');

type Options = {
	code: string;
};

type LoggerLike = {
	info: (...args: unknown[]) => void;
	warn: (...args: unknown[]) => void;
	error: (...args: unknown[]) => void;
	trace: (...args: unknown[]) => void;
	debug: (...args: unknown[]) => void;
};

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'trace', 'debug'] as const;

function buildConsoleShim(logger: LoggerLike) {
	const shim: Record<string, unknown> = {};

	for (const method of CONSOLE_METHODS) {
		const target = method === 'log' ? 'info' : method;

		shim[method] = new ivm.Callback(
			(...rest: unknown[]) => logger[target](rest.length === 1 ? rest[0] : rest),
			{ sync: true }
		);
	}

	return shim;
}

function prepareSandbox(context: any, scriptEnv: Record<string, unknown>, logger: LoggerLike): void {
	const jail = context.global;

	jail.setSync('global', jail.derefInto());
	jail.setSync('module', { exports: null }, { copy: true });
	jail.setSync('process', { env: scriptEnv }, { copy: true });
	jail.setSync('console', buildConsoleShim(logger), { copy: true });
}

const wrapScript = (userCode: string) => `
${userCode};
if (typeof module.exports !== 'function') {
	throw new TypeError('module.exports is not a function');
}
return module.exports($0.data);
`;

export default defineOperationApi<Options>({
	id: 'exec',
	handler: async ({ code }, { data, env, logger }) => {
		const memoryLimitMb = env['FLOWS_RUN_SCRIPT_MAX_MEMORY'];
		const timeoutMs = env['FLOWS_RUN_SCRIPT_TIMEOUT'];
		const scriptEnv = (data['$env'] ?? {}) as Record<string, unknown>;

		const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });

		try {
			const context = await isolate.createContext();

			try {
				prepareSandbox(context, scriptEnv, logger as LoggerLike);

				const inputCopy = new ivm.ExternalCopy({ data: stripFunctions(data) });

				try {
					const resultRef = await context.evalClosure(
						wrapScript(code),
						[inputCopy.copyInto()],
						{
							result: { reference: true, promise: true },
							timeout: timeoutMs,
						}
					);

					try {
						return await resultRef.copy();
					} finally {
						resultRef.release();
					}
				} finally {
					inputCopy.release();
				}
			} finally {
				context.release();
			}
		} finally {
			isolate.dispose();
		}
	},
});
