import { afterEach, describe, expect, it, vi } from 'vitest';

const { pinoCalls, destinationCalls } = vi.hoisted(() => ({
	pinoCalls: [] as unknown[][],
	destinationCalls: [] as number[],
}));

vi.mock('pino', () => {
	const pinoFn = (...args: unknown[]) => {
		pinoCalls.push(args);
		return { info: () => undefined, warn: () => undefined, error: () => undefined };
	};

	(pinoFn as unknown as { destination: (fd: number) => unknown }).destination = (fd: number) => {
		destinationCalls.push(fd);
		return { fd };
	};

	return { pino: pinoFn };
});

vi.mock('pino-http', () => ({
	pinoHttp: () => () => undefined,
	stdSerializers: { req: (request: unknown) => request },
}));

vi.mock('./utils/get-config-from-env.js', () => ({ getConfigFromEnv: () => ({}) }));

async function loadLogger(logStyle: string, toStderr: boolean): Promise<void> {
	pinoCalls.length = 0;
	destinationCalls.length = 0;

	vi.resetModules();

	const MOCK_ENV = { LOG_LEVEL: 'info', LOG_STYLE: logStyle };
	vi.doMock('./env.js', () => ({ default: MOCK_ENV, getEnv: () => MOCK_ENV }));

	vi.stubEnv('CAIRNCMS_LOG_DESTINATION_FD', toStderr ? '2' : undefined);

	await import('./logger.js');
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.doUnmock('./env.js');
	vi.resetModules();
});

describe('logger destination wiring', () => {
	it('raw mode constructs the logger against pino.destination(2) in machine mode', async () => {
		await loadLogger('raw', true);

		expect(destinationCalls).toContain(2);
		expect(pinoCalls[0]![1]).toEqual({ fd: 2 });
	});

	it('raw mode passes no destination outside machine mode', async () => {
		await loadLogger('raw', false);

		expect(pinoCalls[0]).toHaveLength(1);
		expect(destinationCalls).not.toContain(2);
	});

	it('pretty mode sets transport.options.destination to 2 in machine mode', async () => {
		await loadLogger('pretty', true);

		const options = pinoCalls[0]![0] as { transport?: { options?: { destination?: number } } };
		expect(options.transport?.options?.destination).toBe(2);
	});

	it('pretty mode leaves transport.options.destination unset outside machine mode', async () => {
		await loadLogger('pretty', false);

		const options = pinoCalls[0]![0] as { transport?: { options?: { destination?: number } } };
		expect(options.transport?.options?.destination).toBeUndefined();
	});
});
