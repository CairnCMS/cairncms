import type { Accountability, PrimaryKey } from '@cairncms/types';
import { defineOperationApi, optionToObject } from '@cairncms/utils';
import { ItemsService } from '../../services/items.js';
import type { Item } from '../../types/index.js';
import { getAccountabilityForRole } from '../../utils/get-accountability-for-role.js';
import { readStoredTargets, resolveKeySelection, type StoredTargets } from '../../utils/operation-targets.js';
import { sanitizeQuery } from '../../utils/sanitize-query.js';

type Options = {
	collection: string;
	key?: PrimaryKey | PrimaryKey[] | null;
	query?: Record<string, any> | string | null;
	emitEvents: boolean;
	permissions: string; // $public, $trigger, $full, or UUID of a role
};

export default defineOperationApi<Options>({
	id: 'item-read',

	handler: async ({ collection, key, query, emitEvents, permissions }, context) => {
		const { accountability, database, getSchema } = context;

		const targets =
			(context as { storedTargets?: StoredTargets }).storedTargets ?? readStoredTargets('item-read', { key, query });

		let keys: unknown[] | undefined;

		if (targets.key === 'configured') {
			keys = resolveKeySelection(key);
			if (keys.length === 0) return [];
		}

		const schema = await getSchema({ database });
		let customAccountability: Accountability | null;

		if (!permissions || permissions === '$trigger') {
			customAccountability = accountability;
		} else if (permissions === '$full') {
			customAccountability = await getAccountabilityForRole('system', { database, schema, accountability });
		} else if (permissions === '$public') {
			customAccountability = await getAccountabilityForRole(null, { database, schema, accountability });
		} else {
			customAccountability = await getAccountabilityForRole(permissions, { database, schema, accountability });
		}

		const itemsService = new ItemsService(collection, {
			schema,
			accountability: customAccountability,
			knex: database,
		});

		// Unlike a blank saved Query, a configured one that resolves to whitespace still fails to decode, so it never
		// widens to a listing.
		const queryObject = targets.query === 'none' || !query ? {} : optionToObject(query);
		const sanitizedQueryObject = sanitizeQuery(queryObject, customAccountability);

		let result: Item | Item[] | null;

		if (!keys) {
			result = await itemsService.readByQuery(sanitizedQueryObject, { emitEvents: !!emitEvents });
		} else if (keys.length === 1) {
			result = await itemsService.readOne(keys[0] as PrimaryKey, sanitizedQueryObject, { emitEvents: !!emitEvents });
		} else {
			result = await itemsService.readMany(keys as PrimaryKey[], sanitizedQueryObject, { emitEvents: !!emitEvents });
		}

		return result;
	},
});
