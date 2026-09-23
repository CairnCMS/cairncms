import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

beforeEach(() => {
	setActivePinia(
		createTestingPinia({
			createSpy: vi.fn,
			stubActions: false,
		})
	);
});

import { useUserStore } from '@/stores/user';
import { usePermissionsStore } from '@/stores/permissions';
import { useFieldPermissions } from './use-field-permissions';
import { applyConditions } from '@/utils/apply-conditions';
import VForm from '@/components/v-form/v-form.vue';
import FormField from '@/components/v-form/form-field.vue';
import { enableAutoUnmount, shallowMount } from '@vue/test-utils';
import { createI18n } from 'vue-i18n';
import { useCollection } from '@cairncms/composables';
import { Field, FieldMeta } from '@cairncms/types';

vi.mock('@cairncms/composables', async (importOriginal) => ({
	...(await importOriginal<typeof import('@cairncms/composables')>()),
	useCollection: vi.fn(),
}));

const mockUser = {
	id: '00000000-0000-0000-0000-000000000000',
	role: {
		admin_access: false,
		id: '00000000-0000-0000-0000-000000000000',
	},
};

const mockReadPermissions = {
	role: '00000000-0000-0000-0000-000000000000',
	permissions: {
		_and: [{ field_a: { _null: true } }, { field_b: { _null: true } }],
	},
	validation: null,
	presets: null,
	fields: ['id', 'start_date', 'end_date'],
	collection: 'test',
	action: 'read',
};

const mockFields: Field[] = [
	{ collection: 'test', field: 'id', name: 'id', type: 'integer', schema: null, meta: null },
	{ collection: 'test', field: 'name', name: 'name', type: 'string', schema: null, meta: null },
	{ collection: 'test', field: 'start_date', name: 'start_date', type: 'timestamp', schema: null, meta: null },
	{ collection: 'test', field: 'end_date', name: 'end_date', type: 'timestamp', schema: null, meta: null },
];

vi.mock('@/api', () => {
	return {
		default: {
			get: (path: string) => {
				if (path === '/permissions') {
					return Promise.resolve({ data: { data: [mockReadPermissions] } });
				}

				return Promise.reject(new Error(`GET "${path}" is not mocked in this test`));
			},
		},
	};
});

afterEach(() => {
	vi.restoreAllMocks();
});

enableAutoUnmount(afterEach);

describe('useFieldPermissions', () => {
	test('removes fields the caller has no read permission for', async () => {
		const userStore = useUserStore();
		userStore.currentUser = mockUser as any;

		const permissionsStore = usePermissionsStore();
		await permissionsStore.hydrate();

		vi.mocked(useCollection).mockReturnValue({ fields: ref(mockFields) } as any);

		const { fields } = useFieldPermissions(ref('test'), ref(false));
		expect(fields.value.length).toBeGreaterThan(0);

		for (const field of fields.value) {
			expect(mockReadPermissions.fields.includes(field.field)).toBe(true);
		}
	});

	function setup(updateFields: string[] | null, admin = false) {
		const userStore = useUserStore();
		userStore.currentUser = { ...mockUser, role: { ...mockUser.role, admin_access: admin } } as any;

		const permissionsStore = usePermissionsStore();

		(permissionsStore as any).permissions = [
			{
				role: mockUser.role.id,
				collection: 'test',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: ['*'],
			},
			{
				role: mockUser.role.id,
				collection: 'test',
				action: 'update',
				permissions: null,
				validation: null,
				presets: null,
				fields: updateFields,
			},
		];

		vi.mocked(useCollection).mockReturnValue({ fields: ref(mockFields) } as any);

		const { fields } = useFieldPermissions(ref('test'), ref(false));
		return fields.value.filter((field) => (field.meta as any)?.readonly !== true).map((field) => field.field);
	}

	test('marks every field readonly for a null update field list', () => {
		expect(setup(null)).toEqual([]);
	});

	test('marks every field readonly for an empty update field list', () => {
		expect(setup([])).toEqual([]);
	});

	test('leaves only the granted subset editable', () => {
		expect(setup(['name'])).toEqual(['name']);
	});

	test('leaves every field editable for a wildcard grant', () => {
		expect(setup(['*'])).toEqual(['id', 'name', 'start_date', 'end_date']);
	});

	test('leaves every field editable for an admin', () => {
		expect(setup(null, true)).toEqual(['id', 'name', 'start_date', 'end_date']);
	});

	function fieldMeta(overrides: Partial<FieldMeta>): FieldMeta {
		return {
			id: 1,
			collection: 'test',
			field: 'name',
			group: null,
			hidden: false,
			interface: 'input',
			display: null,
			options: null,
			display_options: null,
			readonly: false,
			required: false,
			sort: 1,
			special: null,
			translations: null,
			width: 'full',
			note: null,
			conditions: null,
			validation: null,
			validation_message: null,
			...overrides,
		};
	}

	function fieldWithUnlockCondition(): Field {
		return {
			collection: 'test',
			field: 'name',
			name: 'name',
			type: 'string',
			schema: null,
			meta: fieldMeta({
				readonly: true,
				conditions: [{ name: 'c', rule: { name: { _eq: 'x' } }, readonly: false }],
			}),
		};
	}

	function grants(updateFields: string[] | null) {
		const userStore = useUserStore();
		userStore.currentUser = mockUser as any;

		(usePermissionsStore() as any).permissions = [
			{
				role: mockUser.role.id,
				collection: 'test',
				action: 'read',
				permissions: null,
				validation: null,
				presets: null,
				fields: ['*'],
			},
			{
				role: mockUser.role.id,
				collection: 'test',
				action: 'update',
				permissions: null,
				validation: null,
				presets: null,
				fields: updateFields,
			},
		];
	}

	test('a matching condition cannot re-enable a permission-forbidden field', () => {
		grants([]);

		const input = [fieldWithUnlockCondition()];
		vi.mocked(useCollection).mockReturnValue({ fields: ref(input) } as any);

		const { fields } = useFieldPermissions(ref('test'), ref(false));
		const nameField = fields.value.find((field) => field.field === 'name')!;

		const applied = applyConditions({ name: 'x' }, nameField);
		expect((applied.meta as any).readonly).toBe(true);

		expect(input[0]!.meta!.conditions![0]!.readonly).toBe(false);
	});

	test('a matching condition still unlocks a permitted field', () => {
		grants(['name']);

		const input = [fieldWithUnlockCondition()];
		vi.mocked(useCollection).mockReturnValue({ fields: ref(input) } as any);

		const { fields } = useFieldPermissions(ref('test'), ref(false));
		const nameField = fields.value.find((field) => field.field === 'name')!;

		const applied = applyConditions({ name: 'x' }, nameField);
		expect((applied.meta as any).readonly).toBe(false);
	});

	test('the production form renders a forbidden field disabled when its condition matches', () => {
		grants([]);

		const input = [fieldWithUnlockCondition()];
		vi.mocked(useCollection).mockReturnValue({ fields: ref(input) } as any);

		const { fields } = useFieldPermissions(ref('test'), ref(false));

		const wrapper = shallowMount(VForm, {
			props: { fields: fields.value, modelValue: { name: 'x' }, loading: false },
			global: {
				plugins: [createI18n({ legacy: false })],
				stubs: { 'v-info': true, 'v-divider': true, 'v-button': true },
			},
		});

		const formField = wrapper.findComponent(FormField);
		expect(formField.exists()).toBe(true);
		expect(formField.props('disabled')).toBe(true);
	});
});
