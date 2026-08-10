import { useRevisions } from '@/composables/use-revisions';
import { useServerStore } from '@/stores/server';
import type { Revision } from '@/types/revisions';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { defineComponent, h, ref } from 'vue';
import { createI18n } from 'vue-i18n';

const apiGet = vi.fn();

vi.mock('@/api', () => ({ default: { get: (...args: any[]) => apiGet(...args) } }));

const i18n = createI18n({ legacy: false });

async function mountRevisions(max: number | undefined) {
	apiGet.mockResolvedValue({ data: { data: [], meta: { filter_count: 0 } } });

	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	if (max !== undefined) {
		useServerStore().info.queryLimit = { default: 100, max };
	}

	// eslint-disable-next-line vue/one-component-per-file
	const TestComponent = defineComponent({
		setup: () => useRevisions(ref('articles'), ref('1')),
		render: () => h('div'),
	});

	mount(TestComponent, { global: { plugins: [i18n, pinia] } });
	await flushPromises();
}

afterEach(() => {
	apiGet.mockReset();
});

describe('useRevisions page size', () => {
	test('uses 10 when no maximum is configured', async () => {
		await mountRevisions(undefined);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 10 }) })
		);
	});

	test('uses 10 when the maximum is unlimited', async () => {
		await mountRevisions(-1);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 10 }) })
		);
	});

	test('caps the page size at a maximum below 10', async () => {
		await mountRevisions(5);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 5 }) })
		);
	});

	test('keeps 10 when the maximum is above 10', async () => {
		await mountRevisions(200);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 10 }) })
		);
	});
});

describe('useRevisions created revision across identity changes', () => {
	function makeCreatedRevision(item: string): Revision {
		return {
			id: Number(item) * 11,
			data: {},
			delta: {},
			collection: 'articles',
			item,
			activity: {
				action: 'create',
				ip: '127.0.0.1',
				user_agent: 'test',
				origin: 'test',
				timestamp: '2026-01-02T09:00:00Z',
				user: 'user-1',
			},
			timestampFormatted: 'Jan 2 (9:00)',
		};
	}

	type RevisionsRequestConfig = {
		params: {
			limit?: number;
			filter?: { item?: { _eq?: string } };
		};
	};

	test('a completed identity change fetches the new item creation revision', async () => {
		apiGet.mockImplementation((_path: string, config: RevisionsRequestConfig) => {
			if (config.params.limit === 1 && config.params.filter?.item?._eq) {
				const revision = makeCreatedRevision(config.params.filter.item._eq);
				return Promise.resolve({ data: { data: [revision], meta: { filter_count: 1 } } });
			}

			return Promise.resolve({ data: { data: [], meta: { filter_count: 0 } } });
		});

		const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
		setActivePinia(pinia);

		const primaryKey = ref('1');
		let composable!: ReturnType<typeof useRevisions>;

		// eslint-disable-next-line vue/one-component-per-file
		const TestComponent = defineComponent({
			setup: () => {
				composable = useRevisions(ref('articles'), primaryKey);
				return () => h('div');
			},
		});

		mount(TestComponent, { global: { plugins: [i18n, pinia] } });
		await flushPromises();

		expect(composable.created.value).toEqual(makeCreatedRevision('1'));

		primaryKey.value = '2';
		await flushPromises();

		expect(composable.created.value).toEqual(makeCreatedRevision('2'));
	});
});
