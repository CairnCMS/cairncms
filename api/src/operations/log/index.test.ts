import { afterEach, expect, test, vi } from 'vitest';
import { REDACT_TEXT } from '../../constants.js';
import { collectSensitiveValues, redactFlowLog } from '../../utils/redact-flow-log.js';

const loggerInfo = vi.fn();

vi.doMock('../../logger', () => ({
	default: {
		info: loggerInfo,
	},
}));

const { default: config } = await import('./index.js');

afterEach(() => {
	vi.clearAllMocks();
});

function makeRedactor(
	keyedData: Record<string, unknown> = {},
	confinedValues: string[] = [],
	confinedKeys: string[] = []
) {
	const values = new Set([...collectSensitiveValues(keyedData), ...confinedValues]);
	const keys = new Set(confinedKeys.map((key) => key.toLowerCase()));
	return (value: unknown) => redactFlowLog(value, values, keys);
}

function contextWith(redactForFlowLog: (value: unknown) => unknown) {
	return { redactForFlowLog } as any;
}

test('logs number message as string', () => {
	config.handler({ message: 1 }, contextWith(makeRedactor()));

	expect(loggerInfo).toHaveBeenCalledWith(String(1));
});

test('logs json message as stringified json', () => {
	const message = { test: 'message' };

	config.handler({ message }, contextWith(makeRedactor()));

	expect(loggerInfo).toHaveBeenCalledWith(JSON.stringify(message));
});

test('redacts a value under a sensitive key in the message object', () => {
	config.handler({ message: { password: 'longsecretvalue123' } }, contextWith(makeRedactor()));

	expect(loggerInfo).toHaveBeenCalledWith(JSON.stringify({ password: REDACT_TEXT }));
});

test('redacts a secret that propagates from keyed state into the message string', () => {
	const redactForFlowLog = makeRedactor({ token: 'longsecretvalue123' });

	config.handler({ message: 'user token longsecretvalue123 end' }, contextWith(redactForFlowLog));

	expect(loggerInfo).toHaveBeenCalledWith(`user token ${REDACT_TEXT} end`);
});

test('redacts a confined-declared value carried under a non-sensitive key', () => {
	const redactForFlowLog = makeRedactor({ result: 'confinedsecretvalue12345' }, ['confinedsecretvalue12345']);

	config.handler({ message: 'value is confinedsecretvalue12345' }, contextWith(redactForFlowLog));

	expect(loggerInfo).toHaveBeenCalledWith(`value is ${REDACT_TEXT}`);
});

test('fails closed: with no redactor on the context, the whole message is redacted', () => {
	config.handler({ message: 'anything could be a secret' }, {} as any);

	expect(loggerInfo).toHaveBeenCalledWith(REDACT_TEXT);
});

test('leaves a benign message unchanged when the redactor is present', () => {
	config.handler({ message: 'export finished' }, contextWith(makeRedactor()));

	expect(loggerInfo).toHaveBeenCalledWith('export finished');
});
