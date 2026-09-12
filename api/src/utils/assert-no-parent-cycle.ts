import type { Knex } from 'knex';
import { PARENT_CYCLE_GUARDED_COLLECTIONS } from '../constants.js';
import { InvalidPayloadException } from '../exceptions/index.js';
import type { PrimaryKey } from '../types/index.js';

function canonical(value: unknown): unknown {
	return typeof value === 'string' ? value.toLowerCase() : value;
}

export async function assertNoParentCycle(
	trx: Knex,
	collection: string,
	primaryKeyField: string,
	keys: PrimaryKey[],
	payload: Record<string, any>
): Promise<void> {
	const parentField = PARENT_CYCLE_GUARDED_COLLECTIONS.get(collection);
	if (!parentField || !(parentField in payload)) return;

	const target = payload[parentField];
	if (target === null || target === undefined) return;

	const moved = new Set<unknown>(keys.map(canonical));
	const seen = new Set<unknown>();
	let cursor: unknown = target;

	while (cursor !== null && cursor !== undefined) {
		const key = canonical(cursor);

		if (moved.has(key)) {
			throw new InvalidPayloadException(`Moving a folder under "${String(cursor)}" would create a parent cycle.`);
		}

		if (seen.has(key)) {
			throw new InvalidPayloadException(`The folder hierarchy already contains a cycle at "${String(cursor)}".`);
		}

		seen.add(key);

		const row = await trx.select(parentField).from(collection).where(primaryKeyField, cursor).first();
		if (!row) throw new InvalidPayloadException(`Parent folder "${String(cursor)}" does not exist.`);

		cursor = row[parentField];
	}
}
