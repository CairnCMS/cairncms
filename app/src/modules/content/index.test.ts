import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { ref } from 'vue';
import { useCollectionsStore } from '@/stores/collections';
import type { Collection } from '@/types/collections';
import { useNavigation } from './composables/use-navigation';
import contentModule from './index';

const defaultRoute = (contentModule.routes as any[]).find((route) => route.name === 'no-collections');

function folder(collection: string, sort: number, group: string | null = null): Collection {
	return { collection, meta: { group, sort }, schema: null } as unknown as Collection;
}

function table(collection: string, sort: number, group: string | null = null): Collection {
	return { collection, meta: { group, sort }, schema: { name: collection } } as unknown as Collection;
}

function setup(collections: Collection[], openFolders: string[]) {
	useCollectionsStore().collections = collections;
	useNavigation(ref(null)).activeGroups.value = openFolders;
}

describe('content module default route', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn }));
		localStorage.clear();
	});

	test('opens a collection in an open folder before one in a closed folder sorted ahead of it', () => {
		setup(
			[folder('archive', 1), table('old_posts', 1, 'archive'), folder('content', 2), table('articles', 1, 'content')],
			['content']
		);

		expect(defaultRoute.beforeEnter()).toBe('/content/articles');
	});

	test('falls back to a collection in a closed folder when no open folder holds one', () => {
		setup([folder('archive', 1), table('old_posts', 1, 'archive')], []);

		expect(defaultRoute.beforeEnter()).toBe('/content/old_posts');
	});

	test('falls back to a collection under two closed folders', () => {
		setup([folder('archive', 1), folder('by_year', 1, 'archive'), table('old_posts', 1, 'by_year')], []);

		expect(defaultRoute.beforeEnter()).toBe('/content/old_posts');
	});

	test('opens the remembered collection before any other', () => {
		setup(
			[folder('archive', 1), table('old_posts', 1, 'archive'), folder('content', 2), table('articles', 1, 'content')],
			['content']
		);

		localStorage.setItem('directus-last-accessed-collection', JSON.stringify('old_posts'));

		expect(defaultRoute.beforeEnter()).toBe('/content/old_posts');
	});
});
