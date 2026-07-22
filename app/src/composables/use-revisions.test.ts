import { useRevisions } from '@/composables/use-revisions';
import { useServerStore } from '@/stores/server';
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
	test('uses 100 when no maximum is configured', async () => {
		await mountRevisions(undefined);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 100 }) })
		);
	});

	test('uses 100 when the maximum is unlimited', async () => {
		await mountRevisions(-1);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 100 }) })
		);
	});

	test('caps the page size at a maximum below 100', async () => {
		await mountRevisions(50);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 50 }) })
		);
	});

	test('keeps 100 when the maximum is above 100', async () => {
		await mountRevisions(200);

		expect(apiGet).toHaveBeenNthCalledWith(
			1,
			'/revisions',
			expect.objectContaining({ params: expect.objectContaining({ limit: 100 }) })
		);
	});
});
