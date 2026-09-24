import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useInsightsStore, type CreatePanel } from './insights';

const apiPost = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(() =>
	Promise.resolve({ data: { data: [] } })
);

const apiPatch = vi.fn<(path: string, body?: unknown) => Promise<unknown>>(() =>
	Promise.resolve({ data: { data: [] } })
);

const apiDelete = vi.fn<(path: string, config?: unknown) => Promise<unknown>>(() =>
	Promise.resolve({ data: { data: [] } })
);

vi.mock('@/api', () => ({
	default: {
		get: vi.fn(() => Promise.resolve({ data: { data: [] } })),
		post: (path: string, body?: unknown) => apiPost(path, body),
		patch: (path: string, body?: unknown) => apiPatch(path, body),
		delete: (path: string, config?: unknown) => apiDelete(path, config),
	},
}));

vi.mock('@/extensions', () => ({ useExtensions: () => ({ panels: ref([]) }) }));

function panel(overrides: Partial<CreatePanel> = {}): CreatePanel {
	return {
		id: `_${Math.random().toString(36).slice(2, 10)}`,
		dashboard: 'dash-1',
		type: 'metric',
		options: {},
		width: 4,
		height: 4,
		position_x: 1,
		position_y: 1,
		name: 'Panel',
		...overrides,
	} as CreatePanel;
}

function bodyOf(mock: typeof apiPost) {
	return mock.mock.calls.find(([path]) => path === '/panels')?.[1];
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
	apiPost.mockClear();
	apiPatch.mockClear();
	apiDelete.mockClear();
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('insights store nested-write filtering', () => {
	it('filters a staged create POST to its recorded writable fields', async () => {
		const store = useInsightsStore();
		const created = panel({ id: '_new', name: 'Only name', note: 'dropped' });

		store.stagePanelCreate(created, ['name']);
		await store.saveChanges();

		expect(bodyOf(apiPost)).toEqual([{ name: 'Only name' }]);
	});

	it('submits the full create when no writable fields are recorded (external caller)', async () => {
		const store = useInsightsStore();
		const created = panel({ id: '_dup', name: 'Duplicated' });

		store.stagePanelCreate(created);
		await store.saveChanges();

		const body = bodyOf(apiPost) as Record<string, any>[];
		expect(body[0]).not.toHaveProperty('id');
		expect(body[0]).toMatchObject({ name: 'Duplicated', dashboard: 'dash-1', type: 'metric' });
	});

	it('submits an empty create body for an explicit empty writable grant', async () => {
		const store = useInsightsStore();

		store.stagePanelCreate(panel({ id: '_empty' }), null);
		await store.saveChanges();

		expect(bodyOf(apiPost)).toEqual([{}]);
	});

	it('re-establishes writable fields when a staged create is re-staged', async () => {
		const store = useInsightsStore();

		store.stagePanelCreate(panel({ id: '_dup', name: 'Full', note: 'note', color: '#fff' }));
		store.stagePanelUpdate({ id: '_dup', edits: { name: 'Renamed' }, writableFields: ['name'] });
		await store.saveChanges();

		expect(bodyOf(apiPost)).toEqual([{ name: 'Renamed' }]);
	});

	it('sends a persisted update as an id-carrying batch and preserves other pending edits', async () => {
		const store = useInsightsStore();

		const panelA = '11111111-1111-4111-8111-111111111111';
		const panelB = '22222222-2222-4222-8222-222222222222';

		store.stagePanelUpdate({ id: panelA, edits: { name: 'Renamed' } });
		store.stagePanelUpdate({ id: panelB, edits: { note: 'Second' } });
		await store.saveChanges();

		expect(apiPatch).toHaveBeenCalledWith('/panels', [
			{ id: panelA, name: 'Renamed' },
			{ id: panelB, note: 'Second' },
		]);
	});
});
