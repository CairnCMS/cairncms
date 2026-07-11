import type { Component, MaybeRef, Ref } from 'vue';
import type { Collection } from './collection.js';

export type ItemViewContext = {
	collection: Ref<string>;
	primaryKey: Ref<string | null>;
	collectionInfo: Ref<Collection | null>;
	isNew: Ref<boolean>;
	item: Readonly<Ref<Record<string, any> | null>>;
	onSaved: (callback: (item: Record<string, any>) => void) => void;
	settings: { get(key: string): Promise<unknown> };
};

export interface ItemViewConfig {
	id: string;
	name: string;
	icon: string;
	enabled?: (context: ItemViewContext) => MaybeRef<boolean> | Promise<boolean>;

	// Placement names are a closed platform vocabulary. A split pane's header toggle is
	// platform-rendered from the contribution's name and icon, never declared here.
	placements: {
		splitPane: {
			component: Component;
			minWidth?: number;
		};
	};

	// Assigned by the platform at registration from the owning package, never by the
	// extension itself. Bundle entries carry the bundle name.
	subject?: string;
}
