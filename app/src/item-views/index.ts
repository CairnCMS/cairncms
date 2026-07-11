import { ItemViewConfig } from '@cairncms/types';
import { sortBy } from 'lodash';

export function getInternalItemViews(): ItemViewConfig[] {
	const itemViews = import.meta.glob<ItemViewConfig>('./*/index.ts', { import: 'default', eager: true });

	return sortBy(Object.values(itemViews), 'id');
}
