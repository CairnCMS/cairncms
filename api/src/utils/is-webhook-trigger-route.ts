import type { Request } from 'express';
import { parseRequestTarget } from './parse-request-target.js';
import { UUID_REGEX } from './is-valid-uuid.js';

// Recognition must match Express's case-insensitive, non-strict matching of the
// /flows/trigger/:pk(UUID) route.
const WEBHOOK_TRIGGER_PATH_REGEX = new RegExp(`^/flows/trigger/${UUID_REGEX}/?$`, 'i');

export function isWebhookTriggerPath(path: string | null | undefined): boolean {
	return path != null && WEBHOOK_TRIGGER_PATH_REGEX.test(path);
}

export function isWebhookTriggerRoute(req: Request): boolean {
	if (!req.originalUrl) return false;
	return isWebhookTriggerPath(parseRequestTarget(req.originalUrl)?.pathname);
}
