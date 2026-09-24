import { i18n } from '@/lang';
import { RelationM2M } from '@/composables/use-relation-m2m';
import { useFieldsStore } from '@/stores/fields';
import { usePermissionsStore } from '@/stores/permissions';
import { useUserStore } from '@/stores/user';
import { Field, FieldMeta, Permission } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref } from 'vue';
import Translations from './translations.vue';

enableAutoUnmount(afterEach);

const relationInfo: RelationM2M = {
	relation: {
		collection: 'article_translations',
		field: 'language',
		related_collection: 'languages',
		meta: null,
		schema: null,
	},
	junction: {
		collection: 'article_translations',
		field: 'article',
		related_collection: 'articles',
		meta: null,
		schema: null,
	},
	relatedCollection: {
		name: 'Languages',
		collection: 'languages',
		icon: 'language',
		meta: null,
		schema: null,
		type: 'table',
	},
	relatedPrimaryKeyField: {
		name: 'Code',
		collection: 'languages',
		field: 'code',
		type: 'string',
		meta: null,
		schema: null,
	},
	junctionCollection: {
		name: 'Article Translations',
		collection: 'article_translations',
		icon: 'box',
		meta: null,
		schema: null,
		type: 'table',
	},
	junctionPrimaryKeyField: {
		name: 'ID',
		collection: 'article_translations',
		field: 'id',
		type: 'integer',
		meta: null,
		schema: null,
	},
	junctionField: {
		name: 'Language',
		collection: 'article_translations',
		field: 'language',
		type: 'string',
		meta: null,
		schema: null,
	},
	reverseJunctionField: {
		name: 'Article',
		collection: 'article_translations',
		field: 'article',
		type: 'integer',
		meta: null,
		schema: null,
	},
	sortField: undefined,
	type: 'm2m',
};

const displayItems = ref<Record<string, any>[]>([]);
const fetchedItems = ref<Record<string, any>[]>([]);

vi.mock('@/composables/use-relation-m2m', () => ({ useRelationM2M: () => ({ relationInfo: ref(relationInfo) }) }));

vi.mock('@/composables/use-relation-multiple', () => ({
	useRelationMultiple: () => ({
		create: vi.fn(),
		update: vi.fn(),
		displayItems,
		loading: ref(false),
		fetchedItems,
		getItemEdits: (item: Record<string, any>) => item,
	}),
}));

vi.mock('@/composables/use-window-size', () => ({ useWindowSize: () => ({ width: ref(1200) }) }));

vi.mock('@/utils/fetch-all', () => ({ fetchAll: () => Promise.resolve([{ code: 'en' }, { code: 'de' }]) }));

function fieldMeta(overrides: Partial<FieldMeta>): FieldMeta {
	return {
		id: 1,
		collection: 'article_translations',
		field: 'x',
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

function junctionField(field: string, meta: Partial<FieldMeta> = {}): Field {
	return {
		collection: 'article_translations',
		field,
		name: field,
		type: field === 'id' ? 'integer' : 'string',
		schema: null,
		meta: fieldMeta({ field, ...meta }),
	};
}

const plainFields: Field[] = [junctionField('id'), junctionField('text'), junctionField('title')];

const conditionFields: Field[] = [
	junctionField('id'),
	junctionField('text'),
	junctionField('title', { conditions: [{ name: 'c', rule: { text: { _eq: 'x' } }, readonly: false }] }),
];

function grant(action: Permission['action'], fields: string[] | null): Permission {
	return {
		role: 'role-1',
		collection: 'article_translations',
		action,
		permissions: { owner: { _eq: '$CURRENT_USER' } },
		validation: null,
		presets: null,
		fields,
	};
}

// eslint-disable-next-line vue/one-component-per-file
const LanguageSelect = defineComponent({
	name: 'LanguageSelect',
	props: {
		modelValue: { type: String, default: undefined },
		items: { type: Array, default: () => [] },
		secondary: { type: Boolean, default: false },
	},
	emits: ['update:modelValue'],
	template: '<div class="language-select"><slot name="append" /></div>',
});

// eslint-disable-next-line vue/one-component-per-file
const VForm = defineComponent({
	name: 'VForm',
	props: {
		disabled: { type: Boolean, default: false },
		fields: { type: Array, default: () => [] },
		modelValue: { type: Object, default: undefined },
		initialValues: { type: Object, default: undefined },
		primaryKey: { type: [String, Number], default: undefined },
		badge: { type: String, default: undefined },
	},
	template: '<div class="v-form-stub" />',
});

const stubs = {
	'language-select': LanguageSelect,
	'v-icon': { props: ['name'], template: '<i :data-name="name" @click="$emit(\'click\', $event)" />' },
	'v-divider': { template: '<hr />' },
	'v-form': VForm,
};

function mountTranslations(permissions: Permission[], fields: Field[] = plainFields) {
	const pinia = createTestingPinia({ createSpy: vi.fn, stubActions: false });
	setActivePinia(pinia);

	(useUserStore() as any).currentUser = { role: { id: 'role-1', admin_access: false } };
	(usePermissionsStore() as any).permissions = permissions;
	(useFieldsStore() as any).getFieldsForCollection = () => fields;

	return mount(Translations, {
		props: { collection: 'articles', field: 'translations', primaryKey: '1', value: [] },
		global: { plugins: [i18n, pinia], stubs, directives: { tooltip: {} } },
	});
}

function forms(wrapper: ReturnType<typeof mountTranslations>) {
	return wrapper.findAllComponents(VForm);
}

function fieldsByName(form: ReturnType<typeof forms>[number]) {
	return Object.fromEntries((form.props('fields') as Field[]).map((f) => [f.field, f]));
}

beforeEach(() => {
	displayItems.value = [
		{ id: 1, language: { code: 'en' }, $type: undefined },
		{ language: { code: 'de' }, $type: 'created' },
	];

	fetchedItems.value = [{ id: 1, language: { code: 'en' } }];
});

describe('translations create and update gating', () => {
	it('gates each pane on the operation matching its translation', async () => {
		const wrapper = mountTranslations([grant('update', ['*'])]);
		await flushPromises();

		await wrapper.find('[data-name="flip"]').trigger('click');
		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(false);
		expect(forms(wrapper)[1]!.props('disabled')).toBe(true);

		const selects = wrapper.findAllComponents(LanguageSelect);
		selects[0]!.vm.$emit('update:modelValue', 'de');
		selects[1]!.vm.$emit('update:modelValue', 'en');
		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(true);
		expect(forms(wrapper)[1]!.props('disabled')).toBe(false);
	});

	it('gates a create-only role the opposite way', async () => {
		const wrapper = mountTranslations([grant('create', ['*'])]);
		await flushPromises();

		await wrapper.find('[data-name="flip"]').trigger('click');
		await flushPromises();

		expect(forms(wrapper)[0]!.props('disabled')).toBe(true);
		expect(forms(wrapper)[1]!.props('disabled')).toBe(false);
	});

	it('applies field restrictions to the operation matching each pane, before and after a swap', async () => {
		const wrapper = mountTranslations([grant('update', ['text']), grant('create', null)]);
		await flushPromises();

		await wrapper.find('[data-name="flip"]').trigger('click');
		await flushPromises();

		let firstFields = fieldsByName(forms(wrapper)[0]!);
		let secondFields = fieldsByName(forms(wrapper)[1]!);
		expect(firstFields.text!.meta!.readonly).toBe(false);
		expect(firstFields.title!.meta!.readonly).toBe(true);
		expect(secondFields.text!.meta!.readonly).toBe(true);
		expect(secondFields.title!.meta!.readonly).toBe(true);

		const selects = wrapper.findAllComponents(LanguageSelect);
		selects[0]!.vm.$emit('update:modelValue', 'de');
		selects[1]!.vm.$emit('update:modelValue', 'en');
		await flushPromises();

		firstFields = fieldsByName(forms(wrapper)[0]!);
		secondFields = fieldsByName(forms(wrapper)[1]!);
		expect(firstFields.text!.meta!.readonly).toBe(true);
		expect(firstFields.title!.meta!.readonly).toBe(true);
		expect(secondFields.text!.meta!.readonly).toBe(false);
		expect(secondFields.title!.meta!.readonly).toBe(true);
	});

	it('forces a forbidden field readonly against its condition in both panes and preserves metadata', async () => {
		const wrapper = mountTranslations([grant('update', ['text']), grant('create', null)], conditionFields);
		await flushPromises();

		await wrapper.find('[data-name="flip"]').trigger('click');
		await flushPromises();

		expect(fieldsByName(forms(wrapper)[0]!).title!.meta!.conditions![0]!.readonly).toBe(true);
		expect(fieldsByName(forms(wrapper)[1]!).title!.meta!.conditions![0]!.readonly).toBe(true);

		const selects = wrapper.findAllComponents(LanguageSelect);
		selects[0]!.vm.$emit('update:modelValue', 'de');
		selects[1]!.vm.$emit('update:modelValue', 'en');
		await flushPromises();

		expect(fieldsByName(forms(wrapper)[0]!).title!.meta!.conditions![0]!.readonly).toBe(true);
		expect(fieldsByName(forms(wrapper)[1]!).title!.meta!.conditions![0]!.readonly).toBe(true);

		expect(conditionFields[2]!.meta!.conditions![0]!.readonly).toBe(false);
	});
});
