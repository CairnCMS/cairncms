import type { Preset, User } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { fetchAll } from '@/utils/fetch-all';
import { useUserStore } from '@/stores/user';
import { usePresetsStore } from './presets';

vi.mock('@/utils/fetch-all', () => ({ fetchAll: vi.fn() }));

function makeUser(overrides: Partial<User> = {}): User {
	return {
		id: 'user-id',
		status: 'active',
		first_name: 'Test',
		last_name: 'User',
		email: 'test@example.com',
		token: '',
		last_login: '',
		last_page: '',
		external_id: '',
		tfa_secret: '',
		theme: 'auto',
		role: {
			id: 'role-id',
			name: 'Test Role',
			key: 'test-role',
			description: '',
			icon: 'supervised_user_circle',
			enforce_tfa: false,
			external_id: null,
			ip_whitelist: [],
			app_access: true,
			admin_access: false,
		} satisfies User['role'],
		password_reset_token: null,
		timezone: 'UTC',
		language: 'en-US',
		avatar: null,
		company: null,
		title: null,
		email_notifications: false,
		...overrides,
	};
}

function makePreset(overrides: Partial<Preset> = {}): Preset {
	return {
		id: 1,
		bookmark: null,
		icon: 'bookmark',
		color: null,
		user: null,
		role: null,
		collection: 'articles',
		search: null,
		filter: null,
		layout: null,
		layout_query: null,
		layout_options: null,
		refresh_interval: null,
		...overrides,
	};
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));
});

describe('presets hydrate', () => {
	test('fetches the user, role, and global presets and flattens them', async () => {
		const userStore = useUserStore();
		userStore.currentUser = makeUser();

		const userPreset = makePreset({ id: 1, user: 'user-id' });
		const rolePreset = makePreset({ id: 2, role: 'role-id' });
		const globalPreset = makePreset({ id: 3 });

		vi.mocked(fetchAll)
			.mockResolvedValueOnce([userPreset])
			.mockResolvedValueOnce([rolePreset])
			.mockResolvedValueOnce([globalPreset]);

		const presetsStore = usePresetsStore();
		await presetsStore.hydrate();

		expect(fetchAll).toHaveBeenCalledTimes(3);
		expect(fetchAll).toHaveBeenNthCalledWith(1, '/presets', { params: { 'filter[user][_eq]': 'user-id' } });

		expect(fetchAll).toHaveBeenNthCalledWith(2, '/presets', {
			params: { 'filter[role][_eq]': 'role-id', 'filter[user][_null]': true },
		});

		expect(fetchAll).toHaveBeenNthCalledWith(3, '/presets', {
			params: { 'filter[role][_null]': true, 'filter[user][_null]': true },
		});

		expect(presetsStore.collectionPresets).toEqual(expect.arrayContaining([userPreset, rolePreset, globalPreset]));
	});
});
