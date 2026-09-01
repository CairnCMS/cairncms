import api from '@/api';
import { useCollection } from '@cairncms/composables';
import { AppCollection, Field } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { flushPromises } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { computed, ref } from 'vue';

import { useItem } from './use-item';

vi.mock('@/utils/notify', () => ({
	notify: vi.fn(),
}));

vi.mock('@/api', () => {
	return {
		default: {
			get: vi.fn(),
			post: vi.fn(),
			patch: vi.fn(),
		},
	};
});

vi.mock('@cairncms/composables');

const { validateItemMock } = vi.hoisted(() => ({ validateItemMock: vi.fn(() => [] as any[]) }));
vi.mock('@/utils/validate-item', () => ({ validateItem: (...args: any[]) => validateItemMock(...args) }));

beforeEach(() => {
	setActivePinia(
		createTestingPinia({
			createSpy: vi.fn,
			stubActions: false,
		})
	);
});

afterEach(() => {
	vi.clearAllMocks();
});

describe('Save As Copy', () => {
	const apiGetSpy = vi.spyOn(api, 'get');
	const apiPostSpy = vi.spyOn(api, 'post');

	const mockResponse = {
		data: {
			data: { id: 1 },
		},
	};

	const mockCollection = {
		collection: 'test',
		name: 'test',
		meta: {
			archive_field: null,
			singleton: false,
		},
		schema: {},
	} as AppCollection;

	test('should keep manual primary key', async () => {
		apiGetSpy.mockResolvedValue(mockResponse);
		apiPostSpy.mockResolvedValue(mockResponse);

		const mockPrimaryKeyFieldName = 'id';

		const mockPrimaryKeyField = {
			collection: 'test',
			field: mockPrimaryKeyFieldName,
			type: 'string',
			schema: {
				is_primary_key: true,
				is_generated: false,
			},
			meta: {
				collection: 'test',
				field: mockPrimaryKeyFieldName,
				special: null,
				options: null,
				display_options: null,
				note: null,
				validation_message: null,
			},
		} as Field;

		const mockFields = [
			mockPrimaryKeyField,
			{
				collection: 'test',
				field: 'name',
				type: 'string',
				schema: {},
				meta: {
					collection: 'test',
					field: 'name',
					options: null,
					display_options: null,
					note: null,
					validation_message: null,
				},
			},
		] as Field[];

		vi.mocked(useCollection).mockReturnValue({
			info: computed(() => mockCollection),
			primaryKeyField: computed(() => mockPrimaryKeyField),
			fields: computed(() => mockFields),
		} as any);

		const { saveAsCopy } = useItem(ref('test'), ref(1));

		await saveAsCopy();

		expect(apiPostSpy.mock.lastCall![1]).toHaveProperty(mockPrimaryKeyFieldName);
	});

	test('should omit auto incremented primary key', async () => {
		apiGetSpy.mockResolvedValue(mockResponse);
		apiPostSpy.mockResolvedValue(mockResponse);

		const mockPrimaryKeyFieldName = 'id';

		const mockPrimaryKeyField = {
			collection: 'test',
			field: mockPrimaryKeyFieldName,
			type: 'integer',
			schema: {
				has_auto_increment: true,
				is_primary_key: true,
				is_generated: false,
			},
			meta: {
				collection: 'test',
				field: mockPrimaryKeyFieldName,
				options: null,
				display_options: null,
				note: null,
				validation_message: null,
			},
		} as Field;

		const mockFields = [
			mockPrimaryKeyField,
			{
				collection: 'test',
				field: 'name',
				type: 'string',
				schema: {},
				meta: {
					collection: 'test',
					field: 'name',
					options: null,
					display_options: null,
					note: null,
					validation_message: null,
				},
			},
		] as Field[];

		vi.mocked(useCollection).mockReturnValue({
			info: computed(() => mockCollection),
			primaryKeyField: computed(() => mockPrimaryKeyField),
			fields: computed(() => mockFields),
		} as any);

		const { saveAsCopy } = useItem(ref('test'), ref(1));

		await saveAsCopy();

		expect(apiPostSpy.mock.lastCall![1]).not.toHaveProperty(mockPrimaryKeyFieldName);
	});

	test('should omit special uuid primary key', async () => {
		apiGetSpy.mockResolvedValue(mockResponse);
		apiPostSpy.mockResolvedValue(mockResponse);

		const mockPrimaryKeyFieldName = 'id';

		const mockPrimaryKeyField = {
			collection: 'test',
			field: mockPrimaryKeyFieldName,
			type: 'uuid',
			schema: {
				is_primary_key: true,
				has_auto_increment: false,
				is_generated: false,
			},
			meta: {
				collection: 'test',
				field: mockPrimaryKeyFieldName,
				options: null,
				display_options: null,
				note: null,
				special: ['uuid'],
				validation_message: null,
			},
		} as Field;

		const mockFields = [
			mockPrimaryKeyField,
			{
				collection: 'test',
				field: 'name',
				type: 'string',
				schema: {},
				meta: {
					collection: 'test',
					field: 'name',
					options: null,
					display_options: null,
					note: null,
					validation_message: null,
				},
			},
		] as Field[];

		vi.mocked(useCollection).mockReturnValue({
			info: computed(() => mockCollection),
			primaryKeyField: computed(() => mockPrimaryKeyField),
			fields: computed(() => mockFields),
		} as any);

		const { saveAsCopy } = useItem(ref('test'), ref(1));

		await saveAsCopy();

		expect(apiPostSpy.mock.lastCall![1]).not.toHaveProperty(mockPrimaryKeyFieldName);
	});
});

describe('empty singleton state', () => {
	const apiGetSpy = vi.mocked(api.get);
	const apiPatchSpy = vi.mocked(api.patch);

	const idField = {
		collection: 'test',
		field: 'id',
		type: 'string',
		schema: { is_primary_key: true, is_generated: false },
		meta: { collection: 'test', field: 'id', special: null },
	} as unknown as Field;

	function mockSingleton() {
		vi.mocked(useCollection).mockReturnValue({
			info: computed(
				() => ({ collection: 'test', name: 'test', meta: { singleton: true }, schema: {} } as AppCollection)
			),
			primaryKeyField: computed(() => idField),
			fields: computed(() => [idField]),
		} as any);
	}

	test('derives create state from a loaded empty singleton', async () => {
		mockSingleton();
		apiGetSpy.mockResolvedValue({ data: { data: { id: null } } });

		const { isNew, isNewOrEmptySingleton } = useItem(ref('test'), ref(null));
		await flushPromises();

		expect(isNew.value).toBe(false);
		expect(isNewOrEmptySingleton.value).toBe(true);
	});

	test('treats a populated singleton as not create', async () => {
		mockSingleton();
		apiGetSpy.mockResolvedValue({ data: { data: { id: 1 } } });

		const { isNewOrEmptySingleton } = useItem(ref('test'), ref(null));
		await flushPromises();

		expect(isNewOrEmptySingleton.value).toBe(false);
	});

	test('treats a singleton loaded without its key property as not create', async () => {
		mockSingleton();
		apiGetSpy.mockResolvedValue({ data: { data: { name: 'loaded' } } });

		const { isNewOrEmptySingleton } = useItem(ref('test'), ref(null));
		await flushPromises();

		expect(isNewOrEmptySingleton.value).toBe(false);
	});

	test('treats a failed singleton load as not create', async () => {
		mockSingleton();
		apiGetSpy.mockRejectedValue(new Error('nope'));

		const { isNewOrEmptySingleton } = useItem(ref('test'), ref(null));
		await flushPromises();

		expect(isNewOrEmptySingleton.value).toBe(false);
	});

	test('treats the new-item route as create', async () => {
		mockSingleton();

		const { isNew, isNewOrEmptySingleton } = useItem(ref('test'), ref('+'));
		await flushPromises();

		expect(isNew.value).toBe(true);
		expect(isNewOrEmptySingleton.value).toBe(true);
	});

	test('runs create-mode validation when saving an empty singleton', async () => {
		mockSingleton();
		apiGetSpy.mockResolvedValue({ data: { data: { id: null } } });
		apiPatchSpy.mockResolvedValue({ data: { data: { id: 1 } } });

		const { save } = useItem(ref('test'), ref(null));
		await flushPromises();

		await save();

		expect(validateItemMock.mock.calls.at(-1)?.[2]).toBe(true);
	});

	test('blocks an empty singleton save when validation fails and does not patch', async () => {
		mockSingleton();
		apiGetSpy.mockResolvedValue({ data: { data: { id: null } } });
		validateItemMock.mockReturnValueOnce([{ field: 'name', type: 'required' }] as any);

		const { save } = useItem(ref('test'), ref(null));
		await flushPromises();

		await expect(save()).rejects.toBeDefined();
		expect(apiPatchSpy).not.toHaveBeenCalled();
	});

	test('saves an empty singleton through patch and returns to populated state', async () => {
		mockSingleton();
		apiGetSpy.mockResolvedValue({ data: { data: { id: null } } });
		apiPatchSpy.mockResolvedValue({ data: { data: { id: 1 } } });

		const { save, isNewOrEmptySingleton } = useItem(ref('test'), ref(null));
		await flushPromises();

		expect(isNewOrEmptySingleton.value).toBe(true);

		await save();
		await flushPromises();

		expect(apiPatchSpy).toHaveBeenCalled();
		expect(isNewOrEmptySingleton.value).toBe(false);
	});
});
