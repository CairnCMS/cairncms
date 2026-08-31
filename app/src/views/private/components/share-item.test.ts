import { i18n } from '@/lang';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ShareItem from './share-item.vue';

const { me } = vi.hoisted(() => ({ me: { calls: 0, response: null as any } }));

vi.mock('@/api', () => ({
	default: {
		get: (path: string) => {
			if (path.startsWith('/permissions/me/')) {
				me.calls++;
				return Promise.resolve({ data: { data: me.response } });
			}

			return Promise.reject(new Error(`GET "${path}" is not mocked in this test`));
		},
	},
}));

const stubs = {
	'v-menu': { template: '<div><slot name="activator" :toggle="() => {}" :active="false" /><slot /></div>' },
	'v-list': { template: '<div><slot /></div>' },
	'v-list-item': { template: '<div><slot /></div>' },
	'v-list-item-icon': { template: '<div><slot /></div>' },
	'v-list-item-content': { template: '<div><slot /></div>' },
	'v-icon': { props: ['name'], template: '<i :data-name="name" />' },
	'v-divider': { template: '<hr />' },
};

function makeShare(overrides: Record<string, any> = {}) {
	return {
		id: 's1',
		name: 'Test share',
		max_uses: null,
		times_used: 0,
		date_created: '2024-01-01T00:00:00Z',
		date_end: null,
		date_start: null,
		password: null,
		...overrides,
	};
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
	me.calls = 0;
	me.response = null;

	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: false } };

	(usePermissionsStore() as any).permissions = [
		{
			collection: 'directus_shares',
			action: 'update',
			role: 'role-1',
			permissions: { owner: { _eq: '$CURRENT_USER' } },
		},
	];
});

describe('share-item', () => {
	it('reflects server capabilities and refetches on a same-key share replacement', async () => {
		me.response = { update: { access: true, fields: ['*'] }, delete: { access: false }, share: { access: false } };

		const wrapper = mount(ShareItem, { props: { share: makeShare() }, global: { plugins: [i18n], stubs } });
		await flushPromises();

		expect(me.calls).toBe(1);
		expect(wrapper.find('[data-name="edit"]').exists()).toBe(true);

		me.response = { update: { access: false, fields: null }, delete: { access: false }, share: { access: false } };
		await wrapper.setProps({ share: makeShare({ name: 'Renamed' }) });
		await flushPromises();

		expect(me.calls).toBe(2);
		expect(wrapper.find('[data-name="edit"]').exists()).toBe(false);
	});
});
