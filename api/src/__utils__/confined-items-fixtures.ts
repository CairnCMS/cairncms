import type { ConfinedItemsReader, ConfinedItemsWriter } from '../extensions/confined/host-items.js';

export function readOnlyItemsService(reader: ConfinedItemsReader): ConfinedItemsReader & ConfinedItemsWriter {
	const unexpectedWrite = async (): Promise<never> => {
		throw new Error('Unexpected item write in a read-only fixture');
	};

	return {
		...reader,
		createOne: unexpectedWrite,
		createMany: unexpectedWrite,
		updateOne: unexpectedWrite,
		updateMany: unexpectedWrite,
		deleteOne: unexpectedWrite,
		deleteMany: unexpectedWrite,
	};
}
