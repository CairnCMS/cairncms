import { defineOperationApi, stripFunctions } from '@cairncms/utils';
import { createRequire } from 'node:module';
import { REDACT_TEXT } from '../../constants.js';

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

type Redactor = (value: unknown) => unknown;

type FlowLogRedactor = { redactForFlowLog?: Redactor };

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'trace', 'debug'] as const;

export function redactConsoleArgs(rest: unknown[], redact: Redactor): unknown {
	return redact(rest.length === 1 ? rest[0] : rest);
}

function buildConsoleShim(logger: LoggerLike, redact: Redactor) {
	const shim: Record<string, unknown> = {};

	for (const method of CONSOLE_METHODS) {
		const target = method === 'log' ? 'info' : method;

		shim[method] = new ivm.Callback((...rest: unknown[]) => logger[target](redactConsoleArgs(rest, redact)), {
			sync: true,
		});
	}

	return shim;
}

function prepareSandbox(context: any, scriptEnv: Record<string, unknown>, logger: LoggerLike, redact: Redactor): void {
	const jail = context.global;

	jail.setSync('global', jail.derefInto());
	jail.setSync('module', { exports: null }, { copy: true });
	jail.setSync('process', { env: scriptEnv }, { copy: true });
	jail.setSync('console', buildConsoleShim(logger, redact), { copy: true });
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
	handler: async ({ code }, flowContext) => {
		const { data, env, logger } = flowContext;
		const memoryLimitMb = env['FLOWS_RUN_SCRIPT_MAX_MEMORY'];
		const timeoutMs = env['FLOWS_RUN_SCRIPT_TIMEOUT'];
		const scriptEnv = (data['$env'] ?? {}) as Record<string, unknown>;

		const redact = (flowContext as FlowLogRedactor).redactForFlowLog ?? (() => REDACT_TEXT);

		const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });

		try {
			const context = await isolate.createContext();

			try {
				prepareSandbox(context, scriptEnv, logger as LoggerLike, redact);

				const inputCopy = new ivm.ExternalCopy({ data: stripFunctions(data) });

				try {
					const resultRef = await context.evalClosure(wrapScript(code), [inputCopy.copyInto()], {
						result: { reference: true, promise: true },
						timeout: timeoutMs,
					});

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
