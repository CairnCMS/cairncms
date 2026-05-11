import { describe, expect, test } from 'vitest';
import { REDACT_TEXT } from './constants.js';
import { buildRevisionData, type Step } from './flows.js';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.HEADER_PAYLOAD_LONG_ENOUGH_TO_BE_REAL_TOKEN';

function makeKeyedData(triggerOverrides: Record<string, unknown>): Record<string, unknown> {
	const trigger = {
		path: '/flows/trigger/abc',
		method: 'POST',
		headers: {},
		query: {},
		body: {},
		...triggerOverrides,
	};

	return {
		$trigger: trigger,
		$last: trigger,
		$accountability: null,
		$env: {},
	};
}

describe('buildRevisionData', () => {
	test('redacts Authorization header in $trigger.headers and preserves other trigger fields', () => {
		const keyedData = makeKeyedData({ headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.headers.authorization).toBe(REDACT_TEXT);
		expect(trigger.headers.accept).toBe('application/json');
		expect(trigger.method).toBe('POST');
		expect(trigger.path).toBe('/flows/trigger/abc');
	});

	test('redacts refresh-token cookie in $trigger.headers and preserves other trigger fields', () => {
		const keyedData = makeKeyedData({
			headers: { cookie: `cairncms_refresh_token=${TOKEN}; other=value` },
		});

		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.headers.cookie).toBe(REDACT_TEXT);
		expect(trigger.method).toBe('POST');
		expect(trigger.path).toBe('/flows/trigger/abc');
	});

	test('redacts access_token in $trigger.query', () => {
		const keyedData = makeKeyedData({ query: { access_token: TOKEN, page: '1' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.query.access_token).toBe(REDACT_TEXT);
		expect(trigger.query.page).toBe('1');
		expect(trigger.method).toBe('POST');
	});

	test('redacts access_token in $trigger.body', () => {
		const keyedData = makeKeyedData({ body: { access_token: TOKEN, action: 'sync' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.body.access_token).toBe(REDACT_TEXT);
		expect(trigger.body.action).toBe('sync');
		expect(trigger.method).toBe('POST');
	});

	test('redacts refresh_token in $trigger.body', () => {
		const keyedData = makeKeyedData({ body: { refresh_token: TOKEN, action: 'sync' } });
		const result = buildRevisionData([], keyedData);
		const trigger = (result.data as any).$trigger;

		expect(trigger.body.refresh_token).toBe(REDACT_TEXT);
		expect(trigger.body.action).toBe('sync');
	});

	test('redacts token value carried into a step option by template interpolation', () => {
		const keyedData = makeKeyedData({ body: { access_token: TOKEN } });

		const steps: Step[] = [
			{
				operation: 'op-1',
				key: 'send-notification',
				status: 'resolve',
				options: {
					message: TOKEN,
					target: 'user@example.com',
				},
			},
		];

		const result = buildRevisionData(steps, keyedData);
		const step = result.steps[0] as Step;

		expect(step.options).not.toBeNull();
		expect((step.options as Record<string, unknown>)['message']).toBe(REDACT_TEXT);
		expect((step.options as Record<string, unknown>)['target']).toBe('user@example.com');
		expect(step.operation).toBe('op-1');
		expect(step.key).toBe('send-notification');
		expect(step.status).toBe('resolve');
	});
});
