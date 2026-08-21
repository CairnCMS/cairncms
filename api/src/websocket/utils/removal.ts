import type { SchemaOverview } from '@cairncms/types';
import type { RequestAccountability } from '../../utils/get-anonymous-accountability.js';
import type { WebSocketEvent } from '../messages.js';
import { canonicalItemKey } from '../subscriptions.js';

export function isDeleteFeedEligible(
	collection: string,
	accountability: RequestAccountability,
	schema: SchemaOverview
): boolean {
	if (!Object.hasOwn(schema.collections, collection)) return false;
	if (accountability.admin === true) return true;

	const read = accountability.permissions?.find(
		(permission) => permission.collection === collection && permission.action === 'read'
	);

	if (read === undefined) return false;
	if (Object.keys(read.permissions ?? {}).length > 0) return false;

	const primary = schema.collections[collection]!.primary;
	const fields = read.fields ?? [];

	return fields.includes('*') || fields.includes(primary) || fields.length === 0;
}

export function isDeleteFeedQueryAllowed(rawQuery: Record<string, unknown> | undefined): boolean {
	return rawQuery === undefined || Object.keys(rawQuery).length === 0;
}

export function deletableKeys(
	item: string | undefined,
	event: Extract<WebSocketEvent, { action: 'delete' }>
): (string | number)[] {
	if (item === undefined) return event.keys;
	return event.keys.filter((key) => canonicalItemKey(key) === item);
}
