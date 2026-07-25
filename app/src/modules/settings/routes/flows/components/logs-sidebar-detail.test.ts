import { config, flushPromises, shallowMount } from '@vue/test-utils';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import type { FlowRaw } from '@cairncms/types';
import { useRevisions } from '@/composables/use-revisions';
import type { Revision, RevisionsByDate } from '@/types/revisions';
import LogsSidebarDetail from './logs-sidebar-detail.vue';

vi.mock('@/composables/use-revisions', () => ({ useRevisions: vi.fn() }));
vi.mock('@/extensions', () => ({ useExtensions: () => ({ operations: ref([]) }) }));
vi.mock('../triggers', () => ({ getTriggers: () => ({ triggers: [] }) }));

const i18n = createI18n({ legacy: false });

const paginationPassthrough = defineComponent({
	name: 'VPagination',
	props: {
		modelValue: { type: Number, default: 1 },
		length: { type: Number, default: 0 },
		totalVisible: { type: Number, default: 0 },
	},
	emits: ['update:modelValue'],
	template: '<div />',
});

function makeFlow(): FlowRaw {
	return {
		id: 'flow-1',
		name: 'Flow',
		icon: 'bolt',
		color: null,
		description: null,
		status: 'active',
		trigger: 'manual',
		accountability: 'all',
		options: {},
		operation: null,
		date_created: '2026-01-01T00:00:00Z',
		user_created: 'user-1',
		operations: [],
	};
}

function makeLogRevision(): Revision & { timeRelative: string } {
	return {
		id: 1,
		data: {},
		delta: {},
		collection: 'directus_flows',
		item: 'flow-1',
		activity: {
			action: 'run',
			ip: '127.0.0.1',
			user_agent: 'test',
			origin: 'test',
			timestamp: '2026-01-02T09:00:00Z',
			user: 'user-1',
		},
		timestampFormatted: 'Jan 2 (9:00)',
		timeRelative: '9:00 (just now)',
	};
}

const logGroup = {
	date: new Date('2026-01-02'),
	dateFormatted: 'Today',
	revisions: [makeLogRevision()],
} satisfies RevisionsByDate;

type RevisionsState = {
	revisionsByDate?: RevisionsByDate[] | null;
	revisionsCount?: number;
	loading?: boolean;
	pagesCount?: number;
};

function mountSidebar(state: RevisionsState) {
	const refresh = vi.fn(async (_page?: number) => undefined);

	const composable: ReturnType<typeof useRevisions> = {
		created: ref<Revision | undefined>(undefined),
		revisions: ref<Revision[] | null>(null),
		revisionsByDate: ref(state.revisionsByDate ?? null),
		loading: ref(state.loading ?? false),
		refresh,
		revisionsCount: ref(state.revisionsCount ?? 0),
		pagesCount: ref(state.pagesCount ?? 0),
	};

	vi.mocked(useRevisions).mockReturnValue(composable);

	const wrapper = shallowMount(LogsSidebarDetail, {
		props: { flow: makeFlow() },
		global: {
			plugins: [i18n],
			components: { VPagination: paginationPassthrough },
			stubs: { VPagination: false },
		},
	});

	return { wrapper, refresh };
}

beforeAll(() => {
	config.global.renderStubDefaultSlot = true;
});

afterAll(() => {
	config.global.renderStubDefaultSlot = false;
});

describe('logs sidebar pagination', () => {
	test('renders the pagination control only when there is more than one page', () => {
		const single = mountSidebar({ revisionsByDate: [logGroup], revisionsCount: 5, pagesCount: 1 });

		expect(single.wrapper.findComponent(paginationPassthrough).exists()).toBe(false);

		const multi = mountSidebar({ revisionsByDate: [logGroup], revisionsCount: 12, pagesCount: 2 });
		const pagination = multi.wrapper.findComponent(paginationPassthrough);

		expect(pagination.exists()).toBe(true);
		expect(pagination.props('modelValue')).toBe(1);
		expect(pagination.props('length')).toBe(2);
		expect(pagination.props('totalVisible')).toBe(3);
	});

	test('changing the page refetches that page of logs', async () => {
		const { wrapper, refresh } = mountSidebar({ revisionsByDate: [logGroup], revisionsCount: 12, pagesCount: 2 });

		wrapper.findComponent(paginationPassthrough).vm.$emit('update:modelValue', 2);
		await flushPromises();

		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith(2);
	});
});

describe('logs sidebar loading states', () => {
	test('keeps the loaded list rendered during a refresh', () => {
		const { wrapper } = mountSidebar({
			revisionsByDate: [logGroup],
			revisionsCount: 12,
			pagesCount: 2,
			loading: true,
		});

		expect(wrapper.find('v-progress-linear').exists()).toBe(false);
		expect(wrapper.text()).toContain('9:00 (just now)');
	});

	test('shows the progress bar on initial load only', () => {
		const { wrapper } = mountSidebar({ revisionsByDate: null, loading: true });

		expect(wrapper.find('v-progress-linear').exists()).toBe(true);
	});
});
