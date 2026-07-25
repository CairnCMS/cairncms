import { config, shallowMount } from '@vue/test-utils';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { useRevisions } from '@/composables/use-revisions';
import type { Revision, RevisionsByDate } from '@/types/revisions';
import RevisionsDrawerDetail from './revisions-drawer-detail.vue';

vi.mock('@/composables/use-revisions', () => ({ useRevisions: vi.fn() }));

const i18n = createI18n({ legacy: false });

function makeRevision(): Revision {
	return {
		id: 1,
		data: {},
		delta: {},
		collection: 'articles',
		item: '1',
		activity: {
			action: 'update',
			ip: '127.0.0.1',
			user_agent: 'test',
			origin: 'test',
			timestamp: '2026-01-02T09:00:00Z',
			user: 'user-1',
		},
		timestampFormatted: 'Jan 2 (9:00)',
	};
}

const revisionGroup = {
	date: new Date('2026-01-02'),
	dateFormatted: 'Today',
	revisions: [makeRevision()],
} satisfies RevisionsByDate;

type RevisionsState = {
	revisions?: Revision[] | null;
	revisionsByDate?: RevisionsByDate[] | null;
	revisionsCount?: number;
	loading?: boolean;
	pagesCount?: number;
};

function mountDrawerDetail(state: RevisionsState) {
	const composable: ReturnType<typeof useRevisions> = {
		created: ref<Revision | undefined>(undefined),
		revisions: ref(state.revisions ?? null),
		revisionsByDate: ref(state.revisionsByDate ?? null),
		loading: ref(state.loading ?? false),
		refresh: vi.fn(async (_page?: number) => undefined),
		revisionsCount: ref(state.revisionsCount ?? 0),
		pagesCount: ref(state.pagesCount ?? 0),
	};

	vi.mocked(useRevisions).mockReturnValue(composable);

	return shallowMount(RevisionsDrawerDetail, {
		props: { collection: 'articles', primaryKey: '1' },
		global: { plugins: [i18n] },
	});
}

beforeAll(() => {
	config.global.renderStubDefaultSlot = true;
});

afterAll(() => {
	config.global.renderStubDefaultSlot = false;
});

describe('revisions drawer detail loading guard', () => {
	test('shows the progress bar during any load, even with revisions loaded', () => {
		const wrapper = mountDrawerDetail({
			revisions: [makeRevision()],
			revisionsByDate: [revisionGroup],
			revisionsCount: 12,
			pagesCount: 2,
			loading: true,
		});

		expect(wrapper.find('v-progress-linear').exists()).toBe(true);
		expect(wrapper.find('revisions-date-group-stub').exists()).toBe(false);
	});
});
