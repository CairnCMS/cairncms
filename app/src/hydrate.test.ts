import type { User } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('@/lang/set-language', () => ({ setLanguage: vi.fn() }));
vi.mock('@/utils/geometry/basemap', () => ({ getBasemapSources: () => [{ name: 'test' }] }));

vi.mock('@/composables/use-translation-strings', () => ({
	useTranslationStrings: () => ({ loadParsedTranslationStrings: vi.fn() }),
}));

vi.mock('./extensions', () => ({
	onHydrateExtensions: vi.fn(),
	onDehydrateExtensions: vi.fn(),
	useExtensions: () => ({ panels: { value: [] } }),
}));

import { hydrate } from './hydrate';
import { useAppStore } from '@/stores/app';
import { useFieldsStore } from '@/stores/fields';
import { usePermissionsStore } from '@/stores/permissions';
import { usePresetsStore } from '@/stores/presets';
import { useServerStore } from '@/stores/server';
import { useUserStore } from '@/stores/user';

type CurrentUser = ReturnType<typeof useUserStore>['currentUser'];
type ShareUser = Extract<NonNullable<CurrentUser>, { share: string }>;

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

const shareUser: ShareUser = {
	share: 'share-id',
	role: { id: 'role-id', admin_access: false, app_access: false },
};

function setup(currentUser: User | ShareUser | null, queryLimit: { default: number; max: number } | undefined) {
	const serverStore = useServerStore();
	const presetsStore = usePresetsStore();
	const permissionsStore = usePermissionsStore();
	const fieldsStore = useFieldsStore();
	const userStore = useUserStore();
	const appStore = useAppStore();

	userStore.currentUser = currentUser;
	serverStore.info.queryLimit = queryLimit;

	return { serverStore, presetsStore, permissionsStore, fieldsStore, appStore };
}

beforeEach(() => {
	setActivePinia(createTestingPinia({ createSpy: vi.fn }));
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('hydrate', () => {
	test('resolves the serverStore refresh before any dependent store starts', async () => {
		const { serverStore, presetsStore, permissionsStore, fieldsStore } = setup(makeUser(), undefined);

		let signalStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => (signalStarted = resolve));
		let resolveServer: () => void = () => undefined;

		vi.mocked(serverStore.hydrate).mockImplementation(() => {
			signalStarted();
			return new Promise<void>((resolve) => (resolveServer = resolve));
		});

		const done = hydrate();
		const winner = await Promise.race([started.then(() => 'started'), done.then(() => 'done')]);
		expect(winner).toBe('started');

		expect(serverStore.hydrate).toHaveBeenCalledOnce();
		expect(permissionsStore.hydrate).not.toHaveBeenCalled();
		expect(fieldsStore.hydrate).not.toHaveBeenCalled();
		expect(presetsStore.hydrate).not.toHaveBeenCalled();

		resolveServer();
		await done;

		expect(presetsStore.hydrate).toHaveBeenCalledOnce();
		expect(serverStore.hydrate).toHaveBeenCalledOnce();
	});

	test('refreshes the serverStore for a share before any dependent store starts', async () => {
		const { serverStore, presetsStore, permissionsStore, fieldsStore } = setup(shareUser, undefined);

		let signalStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => (signalStarted = resolve));
		let resolveServer: () => void = () => undefined;

		vi.mocked(serverStore.hydrate).mockImplementation(() => {
			signalStarted();
			return new Promise<void>((resolve) => (resolveServer = resolve));
		});

		const done = hydrate();
		const winner = await Promise.race([started.then(() => 'started'), done.then(() => 'done')]);
		expect(winner).toBe('started');

		expect(serverStore.hydrate).toHaveBeenCalledOnce();
		expect(permissionsStore.hydrate).not.toHaveBeenCalled();
		expect(fieldsStore.hydrate).not.toHaveBeenCalled();
		expect(presetsStore.hydrate).not.toHaveBeenCalled();

		resolveServer();
		await done;

		expect(presetsStore.hydrate).toHaveBeenCalledOnce();
		expect(serverStore.hydrate).toHaveBeenCalledOnce();
	});

	test('skips the serverStore refresh when queryLimit is already present', async () => {
		const { serverStore } = setup(makeUser(), { default: 100, max: 100 });

		await hydrate();

		expect(serverStore.hydrate).not.toHaveBeenCalled();
	});

	test('surfaces a serverStore refresh failure without starting dependent stores', async () => {
		const { serverStore, presetsStore, permissionsStore, fieldsStore, appStore } = setup(makeUser(), undefined);
		const error = new Error('server info unavailable');
		vi.mocked(serverStore.hydrate).mockRejectedValue(error);

		await expect(hydrate()).resolves.toBeUndefined();

		expect(appStore.error).toBe(error);
		expect(permissionsStore.hydrate).not.toHaveBeenCalled();
		expect(fieldsStore.hydrate).not.toHaveBeenCalled();
		expect(presetsStore.hydrate).not.toHaveBeenCalled();
		expect(appStore.hydrated).toBe(true);
	});
});
