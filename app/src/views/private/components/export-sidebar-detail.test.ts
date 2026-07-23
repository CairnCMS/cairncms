import { STORES_INJECT } from '@cairncms/constants';
import type { RawField } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { config, flushPromises, shallowMount } from '@vue/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import ExportSidebarDetail from './export-sidebar-detail.vue';

const apiGet = vi.fn();

vi.mock('@/api', () => ({
	default: {
		get: (path: string, requestConfig?: { params?: unknown }) => apiGet(path, requestConfig),
	},
}));

const i18n = createI18n({ legacy: false });

const idField = {
	collection: 'articles',
	field: 'id',
	type: 'integer',
	name: 'id',
	schema: { is_primary_key: true },
	meta: {},
} satisfies RawField;

type ExportSidebarProps = Partial<InstanceType<typeof ExportSidebarDetail>['$props']>;

function mountExportSidebar(props: ExportSidebarProps = {}) {
	return shallowMount(ExportSidebarDetail, {
		props: { collection: 'articles', ...props },
		global: {
			plugins: [i18n, createTestingPinia({ createSpy: vi.fn })],
			provide: {
				[STORES_INJECT]: {
					useCollectionsStore: () => ({ collections: [] }),
					useFieldsStore: () => ({ getFieldsForCollectionSorted: () => [idField] }),
				},
			},
		},
	});
}

function countRequests() {
	return apiGet.mock.calls.filter(([path]) => path === '/items/articles');
}

async function openDialog(wrapper: ReturnType<typeof mountExportSidebar>) {
	const exportButton = wrapper.findAll('v-button').find((button) => {
		return button.text().includes('export_items');
	});

	expect(exportButton).toBeDefined();
	await exportButton!.trigger('click');
}

beforeAll(() => {
	config.global.renderStubDefaultSlot = true;
});

afterAll(() => {
	config.global.renderStubDefaultSlot = false;
});

afterEach(() => {
	apiGet.mockReset();
	vi.useRealTimers();
});

describe('export sidebar item count fetching', () => {
	test('does not fetch the item count before the export dialog opens', async () => {
		vi.useFakeTimers();
		apiGet.mockResolvedValue({ data: { data: [] } });

		mountExportSidebar();
		await flushPromises();
		vi.advanceTimersByTime(300);
		await flushPromises();

		expect(countRequests()).toHaveLength(0);
	});

	test('opening the dialog fetches the count with exactly the search, filter, and aggregate params', async () => {
		vi.useFakeTimers();
		apiGet.mockResolvedValue({ data: { data: [{ countDistinct: { id: 15 } }] } });

		const wrapper = mountExportSidebar({
			search: 'needle',
			filter: { status: { _eq: 'published' } },
		});

		await flushPromises();
		await openDialog(wrapper);

		vi.advanceTimersByTime(300);
		await flushPromises();

		const requests = countRequests();

		expect(requests).toHaveLength(1);

		expect(requests[0][1].params).toEqual({
			search: 'needle',
			filter: { status: { _eq: 'published' } },
			aggregate: { countDistinct: ['id'] },
		});
	});

	test('changing the search while the dialog is closed schedules no count request', async () => {
		vi.useFakeTimers();
		apiGet.mockResolvedValue({ data: { data: [{ countDistinct: { id: 15 } }] } });

		const wrapper = mountExportSidebar();
		await flushPromises();

		await wrapper.setProps({ search: 'needle' });
		vi.advanceTimersByTime(300);
		await flushPromises();

		expect(countRequests()).toHaveLength(0);
	});

	test('collapses rapid changes while the dialog is open into one request with the latest value', async () => {
		vi.useFakeTimers();
		apiGet.mockResolvedValue({ data: { data: [{ countDistinct: { id: 15 } }] } });

		const wrapper = mountExportSidebar();
		await flushPromises();
		await openDialog(wrapper);

		vi.advanceTimersByTime(300);
		await flushPromises();
		apiGet.mockClear();

		await wrapper.setProps({ search: 'first' });
		vi.advanceTimersByTime(100);
		await wrapper.setProps({ search: 'updated' });
		vi.advanceTimersByTime(300);
		await flushPromises();

		const requests = countRequests();

		expect(requests).toHaveLength(1);
		expect(requests[0][1].params.search).toBe('updated');
	});
});
