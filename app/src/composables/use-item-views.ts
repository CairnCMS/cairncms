import api from '@/api';
import { useLocalStorage } from '@/composables/use-local-storage';
import { useExtensions } from '@/extensions';
import type { Collection, ItemViewConfig, ItemViewContext } from '@cairncms/types';
import {
	computed,
	getCurrentScope,
	isRef,
	onScopeDispose,
	readonly,
	ref,
	watch,
	type ComputedRef,
	type Ref,
	type WatchStopHandle,
	type WritableComputedRef,
} from 'vue';

type UsableItemViews = {
	itemViews: ComputedRef<ItemViewConfig[]>;
	activeItemView: ComputedRef<ItemViewConfig | null>;
	splitViewOpen: WritableComputedRef<boolean>;
	itemViewContext: ComputedRef<ItemViewContext | null>;
	toggleItemView: (config: ItemViewConfig) => void;
	notifyItemViewSaved: (savedItem: Record<string, any>) => void;
};

/** A config id alone can collide across packages, so the platform-stamped subject disambiguates. */
export function itemViewKey(config: ItemViewConfig): string {
	return `${config.subject ?? 'core'}:${config.id}`;
}

export function useItemViews(options: {
	collection: Ref<string>;
	primaryKey: Ref<string | null>;
	collectionInfo: Ref<Collection | null>;
	isNew: Ref<boolean>;
	item: Ref<Record<string, any> | null>;
}): UsableItemViews {
	const { collection, primaryKey, collectionInfo, isNew, item } = options;

	const registry = useExtensions()['item-views'];

	const savedCallbacks: ((savedItem: Record<string, any>) => void)[] = [];

	const readonlyItem = readonly(item) as ItemViewContext['item'];

	const contexts = new Map<ItemViewConfig, ItemViewContext>();

	function contextFor(config: ItemViewConfig): ItemViewContext {
		let context = contexts.get(config);

		if (!context) {
			context = {
				collection,
				primaryKey,
				collectionInfo,
				isNew,
				item: readonlyItem,
				onSaved,
				settings: createSettingsReader(config.subject),
			};

			contexts.set(config, context);
		}

		return context;
	}

	function onSaved(callback: (savedItem: Record<string, any>) => void): void {
		savedCallbacks.push(callback);

		// Tied to the registering pane's scope: a closed pane never reacts to a later save.
		if (getCurrentScope()) {
			onScopeDispose(() => {
				const index = savedCallbacks.indexOf(callback);
				if (index !== -1) savedCallbacks.splice(index, 1);
			});
		}
	}

	function notifyItemViewSaved(savedItem: Record<string, any>): void {
		for (const callback of [...savedCallbacks]) {
			try {
				callback(savedItem);
			} catch (error) {
				// eslint-disable-next-line no-console
				console.warn('Item view onSaved callback failed', error);
			}
		}
	}

	function createSettingsReader(subject: string | undefined): ItemViewContext['settings'] {
		let cachedCollection: string | null = null;
		let cache: Promise<Record<string, unknown>> | null = null;

		return {
			async get(key: string): Promise<unknown> {
				if (!subject) return null;

				if (cache === null || cachedCollection !== collection.value) {
					cachedCollection = collection.value;

					const request: Promise<Record<string, unknown>> = api
						.get('/extension-settings/app', { params: { subject, collection: collection.value } })
						.then((response) => response.data.data ?? {});

					// A failed fetch is never cached: the rejection propagates and the next read retries.
					request.catch(() => {
						if (cache === request) cache = null;
					});

					cache = request;
				}

				const values = await cache;
				return values[key] ?? null;
			},
		};
	}

	const enabledByKey = ref<Record<string, boolean>>({});

	let evaluationRound = 0;
	let enabledWatchStops: WatchStopHandle[] = [];

	function stopEnabledWatchers(): void {
		for (const stop of enabledWatchStops) stop();
		enabledWatchStops = [];
	}

	onScopeDispose(stopEnabledWatchers);

	watch(
		[registry, collection],
		() => {
			const round = ++evaluationRound;

			stopEnabledWatchers();

			const next: Record<string, boolean> = {};

			for (const config of registry.value) {
				const key = itemViewKey(config);
				next[key] = false;

				if (config.enabled === undefined) {
					next[key] = true;
					continue;
				}

				let result: ReturnType<NonNullable<ItemViewConfig['enabled']>>;

				try {
					result = config.enabled(contextFor(config));
				} catch {
					continue;
				}

				if (isRef(result)) {
					next[key] = result.value === true;

					enabledWatchStops.push(
						watch(result, (value) => {
							if (round === evaluationRound) setEnabled(key, value === true);
						})
					);
				} else if (result instanceof Promise) {
					result
						.then((value) => {
							if (round === evaluationRound) setEnabled(key, value === true);
						})
						.catch(() => {
							if (round === evaluationRound) setEnabled(key, false);
						});
				} else {
					next[key] = result === true;
				}
			}

			enabledByKey.value = next;
		},
		{ immediate: true }
	);

	function setEnabled(key: string, value: boolean): void {
		enabledByKey.value = { ...enabledByKey.value, [key]: value };
	}

	const warnedInvalid = new Set<string>();

	const itemViews = computed(() =>
		registry.value.filter((config) => {
			const key = itemViewKey(config);

			if (!config.placements?.splitPane?.component) {
				if (!warnedInvalid.has(key)) {
					warnedInvalid.add(key);
					// eslint-disable-next-line no-console
					console.warn(`Item view "${config.id}" declares no supported placement`);
				}

				return false;
			}

			return enabledByKey.value[key] === true;
		})
	);

	const { data: activeItemViewKey } = useLocalStorage('active-item-view');

	const activeItemView = computed(
		() => itemViews.value.find((config) => itemViewKey(config) === activeItemViewKey.value) ?? null
	);

	function toggleItemView(config: ItemViewConfig): void {
		const key = itemViewKey(config);
		activeItemViewKey.value = activeItemViewKey.value === key ? null : key;
	}

	const splitViewOpen = computed({
		get: () => activeItemView.value !== null,
		set(value) {
			if (value === false) activeItemViewKey.value = null;
		},
	});

	const itemViewContext = computed(() => (activeItemView.value ? contextFor(activeItemView.value) : null));

	return { itemViews, activeItemView, splitViewOpen, itemViewContext, toggleItemView, notifyItemViewSaved };
}
