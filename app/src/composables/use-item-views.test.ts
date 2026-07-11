import { flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { effectScope, isReadonly, nextTick, ref, shallowRef, type EffectScope, type Ref } from 'vue';
import type { ItemViewConfig, ItemViewContext } from '@cairncms/types';

import { itemViewKey, useItemViews } from './use-item-views';

const registry = shallowRef<ItemViewConfig[]>([]);
const apiGetMock = vi.fn();

vi.mock('@/extensions', () => ({
	useExtensions: () => ({ 'item-views': registry }),
}));

vi.mock('@/api', () => ({
	default: { get: (...args: unknown[]) => apiGetMock(...args) },
}));

let scope: EffectScope;

beforeEach(() => {
	scope = effectScope();
	localStorage.clear();
	registry.value = [];
	apiGetMock.mockReset();
});

afterEach(() => {
	scope.stop();
	vi.restoreAllMocks();
});

function makeConfig(overrides: Partial<ItemViewConfig> = {}): ItemViewConfig {
	return {
		id: 'test',
		name: 'Test',
		icon: 'box',
		placements: { splitPane: { component: {} } },
		...overrides,
	} as ItemViewConfig;
}

function setup(optionOverrides: Partial<Parameters<typeof useItemViews>[0]> = {}) {
	const options = {
		collection: ref('articles'),
		primaryKey: ref<string | null>('1'),
		collectionInfo: ref(null),
		isNew: ref(false),
		item: ref<Record<string, any> | null>({ title: 'hello' }),
		...optionOverrides,
	};

	let result!: ReturnType<typeof useItemViews>;

	scope.run(() => {
		result = useItemViews(options as Parameters<typeof useItemViews>[0]);
	});

	return { result, options };
}

test('a contribution without enabled is enabled by default', () => {
	registry.value = [makeConfig()];

	const { result } = setup();

	expect(result.itemViews.value.map((config) => config.id)).toEqual(['test']);
});

test('a sync enabled false hides the contribution', () => {
	registry.value = [makeConfig({ enabled: () => false })];

	const { result } = setup();

	expect(result.itemViews.value).toEqual([]);
});

test('an async enabled resolves into visibility', async () => {
	registry.value = [makeConfig({ enabled: () => Promise.resolve(true) })];

	const { result } = setup();

	expect(result.itemViews.value).toEqual([]);

	await flushPromises();

	expect(result.itemViews.value.map((config) => config.id)).toEqual(['test']);
});

test('a ref enabled tracks reactively', async () => {
	const gate = ref(false);
	registry.value = [makeConfig({ enabled: () => gate })];

	const { result } = setup();

	expect(result.itemViews.value).toEqual([]);

	gate.value = true;
	await nextTick();

	expect(result.itemViews.value.map((config) => config.id)).toEqual(['test']);

	gate.value = false;
	await nextTick();

	expect(result.itemViews.value).toEqual([]);
});

test('a throwing enabled disables the contribution', () => {
	registry.value = [
		makeConfig({
			enabled: () => {
				throw new Error('boom');
			},
		}),
	];

	const { result } = setup();

	expect(result.itemViews.value).toEqual([]);
});

test('a contribution without a split pane placement is skipped with a warning', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

	registry.value = [makeConfig({ placements: {} as ItemViewConfig['placements'] })];

	const { result } = setup();

	expect(result.itemViews.value).toEqual([]);
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('no supported placement'));
});

test('a collection change re-evaluates enabled', async () => {
	const enabled = vi.fn(() => true);
	registry.value = [makeConfig({ enabled })];

	const { options } = setup();

	expect(enabled).toHaveBeenCalledTimes(1);

	(options.collection as Ref<string>).value = 'posts';
	await nextTick();

	expect(enabled).toHaveBeenCalledTimes(2);
});

test('toggling activates one pane, persists it, and closes through splitViewOpen', async () => {
	const one = makeConfig({ id: 'one' });
	const two = makeConfig({ id: 'two' });
	registry.value = [one, two];

	const { result } = setup();

	expect(result.activeItemView.value).toBeNull();
	expect(result.splitViewOpen.value).toBe(false);

	result.toggleItemView(one);
	await nextTick();

	expect(result.activeItemView.value?.id).toBe('one');
	expect(result.splitViewOpen.value).toBe(true);
	expect(result.itemViewContext.value).not.toBeNull();

	result.toggleItemView(two);
	await nextTick();

	expect(result.activeItemView.value?.id).toBe('two');

	result.splitViewOpen.value = false;
	await nextTick();

	expect(result.activeItemView.value).toBeNull();
	expect(result.itemViewContext.value).toBeNull();

	result.toggleItemView(one);
	await nextTick();

	const second = effectScope();
	let restored!: ReturnType<typeof useItemViews>;

	second.run(() => {
		restored = useItemViews({
			collection: ref('articles'),
			primaryKey: ref<string | null>('1'),
			collectionInfo: ref(null),
			isNew: ref(false),
			item: ref(null),
		});
	});

	expect(restored.activeItemView.value?.id).toBe('one');
	second.stop();
});

test('contributions with the same id from different packages stay distinct', async () => {
	const first = makeConfig({ id: 'custom', subject: 'cairncms-extension-a' });
	const second = makeConfig({ id: 'custom', subject: 'cairncms-extension-b' });
	registry.value = [first, second];

	const { result } = setup();

	expect(result.itemViews.value).toHaveLength(2);
	expect(itemViewKey(first)).not.toBe(itemViewKey(second));

	result.toggleItemView(second);
	await nextTick();

	expect(result.activeItemView.value).toBe(second);

	result.toggleItemView(first);
	await nextTick();

	expect(result.activeItemView.value).toBe(first);
});

test('ref enabled watchers die with the composable scope', async () => {
	const gate = ref(true);
	registry.value = [makeConfig({ enabled: () => gate })];

	const { result } = setup();

	expect(result.itemViews.value).toHaveLength(1);

	scope.stop();

	gate.value = false;
	await nextTick();

	expect(result.itemViews.value).toHaveLength(1);
});

test('onSaved delivers the saved item, contains callback errors, and dies with its scope', () => {
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

	let captured: ItemViewContext | undefined;

	registry.value = [
		makeConfig({
			enabled: (context) => {
				captured = context;
				return true;
			},
		}),
	];

	const { result } = setup();

	const throwing = vi.fn(() => {
		throw new Error('boom');
	});

	const surviving = vi.fn();
	const disposed = vi.fn();

	captured!.onSaved(throwing);
	captured!.onSaved(surviving);

	const paneScope = effectScope();

	paneScope.run(() => {
		captured!.onSaved(disposed);
	});

	paneScope.stop();

	result.notifyItemViewSaved({ title: 'fresh' });

	expect(throwing).toHaveBeenCalledWith({ title: 'fresh' });
	expect(surviving).toHaveBeenCalledWith({ title: 'fresh' });
	expect(disposed).not.toHaveBeenCalled();
	expect(warn).toHaveBeenCalledWith(expect.stringContaining('onSaved callback failed'), expect.any(Error));
});

test('the context item is readonly', () => {
	let captured: ItemViewContext | undefined;

	registry.value = [
		makeConfig({
			enabled: (context) => {
				captured = context;
				return true;
			},
		}),
	];

	setup();

	expect(isReadonly(captured!.item)).toBe(true);
});

test('the settings reader fetches once per collection, scoped to the subject', async () => {
	let captured: ItemViewContext | undefined;

	registry.value = [
		makeConfig({
			subject: '@cairncms/extension-live-preview',
			enabled: (context) => {
				captured = context;
				return true;
			},
		}),
	];

	apiGetMock.mockResolvedValue({ data: { data: { preview_url: 'https://x' } } });

	const { options } = setup();

	expect(await captured!.settings.get('preview_url')).toBe('https://x');
	expect(await captured!.settings.get('undeclared')).toBeNull();

	expect(apiGetMock).toHaveBeenCalledTimes(1);

	expect(apiGetMock).toHaveBeenCalledWith('/extension-settings/app', {
		params: { subject: '@cairncms/extension-live-preview', collection: 'articles' },
	});

	(options.collection as Ref<string>).value = 'posts';
	await nextTick();

	await captured!.settings.get('preview_url');

	expect(apiGetMock).toHaveBeenCalledTimes(2);

	expect(apiGetMock).toHaveBeenLastCalledWith('/extension-settings/app', {
		params: { subject: '@cairncms/extension-live-preview', collection: 'posts' },
	});
});

test('the settings reader returns null without a subject and never calls the api', async () => {
	let captured: ItemViewContext | undefined;

	registry.value = [
		makeConfig({
			enabled: (context) => {
				captured = context;
				return true;
			},
		}),
	];

	setup();

	expect(await captured!.settings.get('preview_url')).toBeNull();
	expect(apiGetMock).not.toHaveBeenCalled();
});

test('a failed settings fetch propagates and the next read retries', async () => {
	let captured: ItemViewContext | undefined;

	registry.value = [
		makeConfig({
			subject: '@cairncms/extension-live-preview',
			enabled: (context) => {
				captured = context;
				return true;
			},
		}),
	];

	apiGetMock.mockRejectedValueOnce(new Error('offline'));
	apiGetMock.mockResolvedValue({ data: { data: { preview_url: 'https://x' } } });

	setup();

	await expect(captured!.settings.get('preview_url')).rejects.toThrowError('offline');

	expect(await captured!.settings.get('preview_url')).toBe('https://x');
	expect(apiGetMock).toHaveBeenCalledTimes(2);
});
