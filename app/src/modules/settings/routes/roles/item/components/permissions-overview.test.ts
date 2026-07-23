import { createTestingPinia } from '@pinia/testing';
import { flushPromises, shallowMount } from '@vue/test-utils';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createI18n } from 'vue-i18n';
import PermissionsOverview from './permissions-overview.vue';

const apiGet = vi.fn();

vi.mock('@/api', () => ({
	default: { get: (path: string, config?: { params?: unknown }) => apiGet(path, config) },
}));

const i18n = createI18n({ legacy: false });

function mountOverview(props: Record<string, unknown>) {
	return shallowMount(PermissionsOverview, {
		props,
		global: { plugins: [i18n, createTestingPinia({ createSpy: vi.fn })] },
	});
}

function permissionRequests() {
	return apiGet.mock.calls.filter(([path]) => path === '/permissions');
}

afterEach(() => {
	apiGet.mockReset();
});

describe('permissions-overview initial fetch', () => {
	test('issues exactly one non-paginated /permissions request with only the role filter', async () => {
		apiGet.mockResolvedValue({ data: { data: [] } });

		mountOverview({ role: 'role-id' });
		await flushPromises();

		const requests = permissionRequests();

		expect(requests).toHaveLength(1);
		expect(requests[0][1]).toEqual({ params: { filter: { role: { _eq: 'role-id' } } } });
	});

	test('changing the permission triggers exactly one additional request', async () => {
		apiGet.mockResolvedValue({ data: { data: [] } });

		const wrapper = mountOverview({ role: 'role-id' });
		await flushPromises();
		apiGet.mockClear();

		await wrapper.setProps({ permission: 'permission-1' });
		await flushPromises();

		expect(permissionRequests()).toHaveLength(1);
	});
});
