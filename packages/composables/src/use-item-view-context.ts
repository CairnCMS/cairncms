import { ITEM_VIEW_CONTEXT_INJECT } from '@cairncms/constants';
import type { ItemViewContext } from '@cairncms/types';
import { inject, type Ref } from 'vue';

export function useItemViewContext(): ItemViewContext {
	const context = inject<Ref<ItemViewContext | null>>(ITEM_VIEW_CONTEXT_INJECT);

	if (!context?.value) throw new Error('[useItemViewContext]: The item view context could not be found.');

	return context.value;
}
