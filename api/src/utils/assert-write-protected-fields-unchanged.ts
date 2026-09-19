import type { Knex } from 'knex';
import { WRITE_PROTECTED_FIELDS } from '../constants.js';
import { InvalidPayloadException } from '../exceptions/index.js';
import type { PrimaryKey } from '../types/index.js';

export async function assertWriteProtectedFieldsUnchanged(
	trx: Knex,
	collection: string,
	primaryKeyField: string,
	keys: PrimaryKey[],
	payload: Record<string, any>
): Promise<void> {
	const protectedFields = WRITE_PROTECTED_FIELDS.get(collection);
	if (!protectedFields) return;

	const changedFields = protectedFields.filter((field) => field in payload);
	if (changedFields.length === 0) return;

	const rows = await trx
		.select(primaryKeyField, ...changedFields)
		.from(collection)
		.whereIn(primaryKeyField, keys);

	for (const row of rows) {
		for (const field of changedFields) {
			if (row[field] !== payload[field]) {
				throw new InvalidPayloadException(`Field "${field}" cannot be changed after creation.`);
			}
		}
	}
}
