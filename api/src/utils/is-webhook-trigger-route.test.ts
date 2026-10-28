import type { Request } from 'express';
import { describe, expect, test } from 'vitest';
import { isWebhookTriggerPath, isWebhookTriggerRoute } from './is-webhook-trigger-route.js';

const UUID = '11111111-1111-1111-1111-111111111111';

describe('isWebhookTriggerPath', () => {
	test('matches the webhook trigger route', () => {
		expect(isWebhookTriggerPath(`/flows/trigger/${UUID}`)).toBe(true);
	});

	test('does not match an ordinary path', () => {
		expect(isWebhookTriggerPath('/items/books')).toBe(false);
	});

	test('is false for a missing path', () => {
		expect(isWebhookTriggerPath(null)).toBe(false);
		expect(isWebhookTriggerPath(undefined)).toBe(false);
	});
});

describe('isWebhookTriggerRoute', () => {
	test('matches a request to the webhook trigger route', () => {
		expect(isWebhookTriggerRoute({ originalUrl: `/flows/trigger/${UUID}` } as Request)).toBe(true);
	});

	test('is false for a request target that cannot be parsed', () => {
		expect(isWebhookTriggerRoute({ originalUrl: `http://[/flows/trigger/${UUID}` } as Request)).toBe(false);
	});

	test('is false when there is no original url', () => {
		expect(isWebhookTriggerRoute({ originalUrl: '' } as Request)).toBe(false);
	});
});
