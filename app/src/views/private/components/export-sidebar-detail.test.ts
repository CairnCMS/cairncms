import { STORES_INJECT } from '@cairncms/constants';
import type { RawField } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { config, flushPromises, shallowMount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { defineComponent } from 'vue';
import { createI18n } from 'vue-i18n';
import { useServerStore } from '@/stores/server';
import { downloadLocalExport } from '@/utils/download-local-export';
import ExportSidebarDetail from './export-sidebar-detail.vue';

const apiGet = vi.fn();
const apiPost = vi.fn();

vi.mock('@/api', () => ({
	default: {
		get: (path: string, requestConfig?: { params?: unknown }) => apiGet(path, requestConfig),
		post: (path: string, body?: unknown) => apiPost(path, body),
	},
}));

vi.mock('@/utils/download-local-export', () => ({
	downloadLocalExport: vi.fn(),
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

const drawerPassthrough = {
	template: '<div><slot /><slot name="actions" /></div>',
};

const selectPassthrough = defineComponent({
	name: 'VSelect',
	props: {
		modelValue: { type: [String, Number], default: undefined },
		items: { type: Array as () => { value: string; text: string }[], default: undefined },
		disabled: { type: Boolean, default: false },
	},
	emits: ['update:modelValue'],
	template: '<div />',
});

type ExportSidebarProps = Partial<InstanceType<typeof ExportSidebarDetail>['$props']>;

function mountExportSidebar(props: ExportSidebarProps = {}, queryLimit?: { default: number; max: number }) {
	const pinia = createTestingPinia({ createSpy: vi.fn });
	setActivePinia(pinia);

	if (queryLimit) {
		useServerStore().info.queryLimit = queryLimit;
	}

	return shallowMount(ExportSidebarDetail, {
		props: { collection: 'articles', ...props },
		global: {
			plugins: [i18n, pinia],
			components: { VDrawer: drawerPassthrough, VSelect: selectPassthrough },
			stubs: { VDrawer: false, VSelect: false },
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

function locationSelect(wrapper: ReturnType<typeof mountExportSidebar>) {
	return wrapper.findAllComponents(selectPassthrough).find((select) => {
		return select.props('items')?.[0]?.value === 'download';
	});
}

function noticeType(wrapper: ReturnType<typeof mountExportSidebar>) {
	return wrapper.find('v-notice.full').attributes('type');
}

async function openDialog(wrapper: ReturnType<typeof mountExportSidebar>) {
	const exportButton = wrapper.findAll('v-button').find((button) => {
		return button.text().includes('export_items');
	});

	expect(exportButton).toBeDefined();
	await exportButton!.trigger('click');
	await flushPromises();
}

async function startExport(wrapper: ReturnType<typeof mountExportSidebar>) {
	const startButton = wrapper.findAll('v-button').find((button) => {
		return button.find('v-icon').exists();
	});

	expect(startButton).toBeDefined();
	await startButton!.trigger('click');
	await flushPromises();
}

beforeAll(() => {
	config.global.renderStubDefaultSlot = true;
});

afterAll(() => {
	config.global.renderStubDefaultSlot = false;
});

afterEach(() => {
	apiGet.mockReset();
	apiPost.mockReset();
	vi.mocked(downloadLocalExport).mockReset();
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

	test('changing the search refetches the count once after the debounce window', async () => {
		vi.useFakeTimers();
		apiGet.mockResolvedValue({ data: { data: [{ countDistinct: { id: 15 } }] } });

		const wrapper = mountExportSidebar();
		await flushPromises();

		await wrapper.setProps({ search: 'needle' });
		vi.advanceTimersByTime(300);
		await flushPromises();

		const requests = countRequests();

		expect(requests).toHaveLength(1);
		expect(requests[0][1].params.search).toBe('needle');
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

describe('export sidebar query limit forcing', () => {
	test.each(['download', 'files'])(
		'a projected export above the maximum locks the location and restores %s on unlock',
		async (priorLocation) => {
			const wrapper = mountExportSidebar({ layoutQuery: { limit: 5 } }, { default: 25, max: 10 });
			await flushPromises();

			if (priorLocation === 'files') {
				locationSelect(wrapper)!.vm.$emit('update:modelValue', 'files');
				await flushPromises();
			}

			expect(noticeType(wrapper)).toBe('normal');
			expect(locationSelect(wrapper)!.props('modelValue')).toBe(priorLocation);

			await wrapper.setProps({ layoutQuery: { limit: -1 } });
			await flushPromises();

			expect(noticeType(wrapper)).toBe('warning');
			expect(locationSelect(wrapper)!.props('modelValue')).toBe('files');
			expect(locationSelect(wrapper)!.props('disabled')).toBe(true);

			await wrapper.setProps({ layoutQuery: { limit: 5 } });
			await flushPromises();

			expect(noticeType(wrapper)).toBe('normal');
			expect(locationSelect(wrapper)!.props('modelValue')).toBe(priorLocation);
			expect(locationSelect(wrapper)!.props('disabled')).toBe(false);
		}
	);

	test('starting a forced export posts the unlimited query to the file library endpoint', async () => {
		apiGet.mockResolvedValue({ data: { data: [{ countDistinct: { id: 15 } }] } });
		apiPost.mockResolvedValue({});

		const wrapper = mountExportSidebar({ layoutQuery: { limit: -1 } }, { default: 25, max: 10 });
		await flushPromises();
		await openDialog(wrapper);
		await startExport(wrapper);

		expect(apiPost).toHaveBeenCalledTimes(1);
		expect(apiPost.mock.calls[0][0]).toBe('/utils/export/articles');
		expect(apiPost.mock.calls[0][1].query.limit).toBe(-1);
		expect(downloadLocalExport).not.toHaveBeenCalled();
	});

	test('starting an unforced export downloads locally with the settings and the configured maximum', async () => {
		apiGet.mockResolvedValue({ data: { data: [{ countDistinct: { id: 15 } }] } });

		const wrapper = mountExportSidebar({ layoutQuery: { limit: 5 } }, { default: 25, max: 10 });
		await flushPromises();
		await openDialog(wrapper);
		await startExport(wrapper);

		expect(downloadLocalExport).toHaveBeenCalledTimes(1);

		const call = vi.mocked(downloadLocalExport).mock.calls[0];

		expect(call[0]).toBe('articles');
		expect(call[1]).toBe('csv');
		expect(call[2]).toMatchObject({ limit: 5 });
		expect(call[3]).toBe(10);
		expect(apiPost).not.toHaveBeenCalled();
	});
});
