import type { Accountability, PrimaryKey } from '@cairncms/types';
import { defineOperationApi } from '@cairncms/utils';
import { ItemsService } from '../../services/items.js';
import { getAccountabilityForRole } from '../../utils/get-accountability-for-role.js';
import {
	decodeQueryOption,
	readStoredTargets,
	requireFilterCondition,
	requireQuerySelection,
	resolveKeySelection,
	type StoredTargets,
} from '../../utils/operation-targets.js';
import { sanitizeQuery } from '../../utils/sanitize-query.js';

type Options = {
	collection: string;
	key?: PrimaryKey | PrimaryKey[] | null;
	query?: Record<string, any> | string | null;
	emitEvents: boolean;
	permissions: string; // $public, $trigger, $full, or UUID of a role
};

export default defineOperationApi<Options>({
	id: 'item-delete',

	handler: async ({ collection, key, query, emitEvents, permissions }, context) => {
		const { accountability, database, getSchema } = context;

		const targets =
			(context as { storedTargets?: StoredTargets }).storedTargets ?? readStoredTargets('item-delete', { key, query });

		let keys: unknown[] | undefined;
		let queryObject: Record<string, any> = {};
		let filterOnly = false;

		if (targets.key === 'configured') {
			keys = resolveKeySelection(key);
			if (keys.length === 0) return [];
		} else {
			const decoded = decodeQueryOption(query, targets.query);
			({ filterOnly } = requireQuerySelection(decoded));
			queryObject = decoded as Record<string, any>;
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

		const itemsService: ItemsService = new ItemsService(collection, {
			schema,
			accountability: customAccountability,
			knex: database,
		});

		if (keys) {
			if (keys.length === 1) {
				return await itemsService.deleteOne(keys[0] as PrimaryKey, { emitEvents: !!emitEvents });
			}

			return await itemsService.deleteMany(keys as PrimaryKey[], { emitEvents: !!emitEvents });
		}

		const sanitizedQueryObject = sanitizeQuery(queryObject, customAccountability);

		if (filterOnly) {
			await requireFilterCondition(collection, sanitizedQueryObject.filter, {
				schema,
				accountability: customAccountability,
				knex: database,
			});
		}

		return await itemsService.deleteByQuery(sanitizedQueryObject, { emitEvents: !!emitEvents });
	},
});
