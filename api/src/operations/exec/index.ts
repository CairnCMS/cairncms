import { defineOperationApi, stripFunctions } from '@cairncms/utils';
import { createRequire } from 'node:module';
import { REDACT_TEXT } from '../../constants.js';
import { InvalidConfigException } from '../../exceptions/index.js';
import { type BoundedSpec, parseCount } from '../../utils/parse-config.js';

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

const TIMEOUT_MESSAGE = 'Script execution timed out.';

const TIMEOUT_SPEC: BoundedSpec = {
	envVar: 'FLOWS_RUN_SCRIPT_TIMEOUT',
	defaultValue: 10_000,
	floor: 1,
	ceiling: 2_147_483_647,
};

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

function startDeadline(timeoutMs: number) {
	const expiresAt = performance.now() + timeoutMs;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const expired = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(TIMEOUT_MESSAGE)), timeoutMs);
	});

	return {
		race: <T>(work: Promise<T>) => Promise.race([work, expired]),
		remainingMs: () => Math.floor(expiresAt - performance.now()),
		clear: () => clearTimeout(timer),
	};
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
		const scriptEnv = (data['$env'] ?? {}) as Record<string, unknown>;

		const timeout = parseCount(env['FLOWS_RUN_SCRIPT_TIMEOUT'], TIMEOUT_SPEC);
		if (!timeout.ok) throw new InvalidConfigException(timeout.error.message);

		const redact = (flowContext as FlowLogRedactor).redactForFlowLog ?? (() => REDACT_TEXT);

		const isolate = new ivm.Isolate({ memoryLimit: memoryLimitMb });
		const deadline = startDeadline(timeout.value);

		try {
			const context = await deadline.race<any>(isolate.createContext());

			try {
				prepareSandbox(context, scriptEnv, logger as LoggerLike, redact);

				const inputCopy = new ivm.ExternalCopy({ data: stripFunctions(data) });

				try {
					const remainingMs = deadline.remainingMs();
					if (remainingMs < 1) throw new Error(TIMEOUT_MESSAGE);

					const resultRef = await deadline.race<any>(
						context.evalClosure(wrapScript(code), [inputCopy.copyInto()], {
							result: { reference: true, promise: true },
							timeout: remainingMs,
						})
					);

					try {
						return await deadline.race<unknown>(resultRef.copy());
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
			deadline.clear();
			isolate.dispose();
		}
	},
});
