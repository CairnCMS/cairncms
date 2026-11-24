import { i18n } from '@/lang';
import { useFieldsStore } from '@/stores/fields';
import { useRelationsStore } from '@/stores/relations';
import type { Filter } from '@cairncms/types';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { describe, expect, it, vi } from 'vitest';
import VFieldListItem from '@/components/v-field-list/v-field-list-item.vue';
import VFieldListComponent from '@/components/v-field-list/v-field-list.vue';
import Nodes from './nodes.vue';

vi.mock('vuedraggable', () => ({
	default: {
		name: 'Draggable',
		props: ['list'],
		template:
			'<ul><template v-for="(element, index) in list" :key="index"><slot name="item" :element="element" :index="index" /></template></ul>',
	},
}));

const VSelect = { name: 'VSelect', props: ['items', 'modelValue'], template: '<div />' };
const VFieldList = { name: 'VFieldList', template: '<div />' };
const VList = { name: 'VList', template: '<div><slot /></div>' };
const SlotStub = { template: '<div><slot /></div>' };

const OPERATORS = ['_istarts_with', '_nistarts_with', '_iends_with', '_niends_with'];

const COLUMNS: [string, string, string, string][] = [
	['articles', 'code', 'string', 'varchar'],
	['articles', 'title', 'string', 'varchar'],
	['articles', 'span', 'string', 'interval'],
	['articles', 'data', 'binary', 'blob'],
	['articles', 'rank', 'integer', 'integer'],
	['articles', 'owner', 'integer', 'integer'],
	['users', 'id', 'integer', 'integer'],
	['users', 'code', 'string', 'varchar'],
	['users', 'team', 'integer', 'integer'],
	['teams', 'id', 'integer', 'integer'],
	['teams', 'span', 'string', 'interval'],
	['teams', 'label', 'string', 'varchar'],
];

function manyToOne(collection: string, field: string, related: string) {
	return {
		collection,
		field,
		related_collection: related,
		schema: null,
		meta: {
			many_collection: collection,
			many_field: field,
			one_collection: related,
			one_field: null,
			junction_field: null,
		},
	};
}

function mountNodes(filter: Filter[], { includeValidation = false, picker = false } = {}) {
	setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));

	useFieldsStore().fields = COLUMNS.map(
		([collection, field, type, dataType]) =>
			({ collection, field, name: field, type, schema: { data_type: dataType }, meta: null } as any)
	);

	useRelationsStore().relations = [manyToOne('articles', 'owner', 'users'), manyToOne('users', 'team', 'teams')] as any;

	return mount(Nodes, {
		props: { filter, collection: 'articles', includeValidation },
		global: {
			plugins: [i18n],
			components: picker ? { 'v-field-list': VFieldListComponent } : {},
			stubs: {
				'v-select': VSelect,
				'v-menu': SlotStub,
				'v-icon': true,
				'input-group': true,
				...(picker
					? {
							'v-list': VList,
							'v-list-group': SlotStub,
							'v-list-item': SlotStub,
							'v-list-item-content': SlotStub,
							'v-list-item-icon': SlotStub,
							'v-text-overflow': true,
							'v-divider': true,
					  }
					: { 'v-field-list': VFieldList }),
			},
			directives: { tooltip: {} },
		},
	});
}

function offeredComparators(wrapper: ReturnType<typeof mountNodes>): string[] {
	return wrapper
		.findComponent(VSelect)
		.props('items')
		.map((item: { value: string }) => item.value);
}

function changeField(wrapper: ReturnType<typeof mountNodes>, field: string) {
	wrapper.findComponent(VFieldList).vm.$emit('add', [field]);
	return wrapper.emitted('update:filter')?.at(-1)?.[0];
}

function pickerFields(wrapper: ReturnType<typeof mountNodes>): Record<string, boolean> {
	return Object.fromEntries(
		wrapper
			.findAllComponents(VFieldListItem)
			.map((item) => [item.props('field').key, item.props('field').disabled])
			.filter(([key]) => key !== '')
	);
}

async function disabledPickerFields(wrapper: ReturnType<typeof mountNodes>) {
	expect(Object.keys(pickerFields(wrapper))).not.toContain('owner.team.span');

	wrapper.findComponent(VList).vm.$emit('toggle', { value: 'owner' });
	await wrapper.vm.$nextTick();

	return pickerFields(wrapper);
}

describe('filter comparators by column type', () => {
	it.each(['data', 'span'])(
		'leaves the case-insensitive starts and ends operators out of a filter on the %s column',
		(field) => {
			const offered = offeredComparators(mountNodes([{ [field]: { _eq: 'x' } }]));

			expect(offered.filter((operator) => OPERATORS.includes(operator))).toEqual([]);
			expect(offered).toContain('_starts_with');
		}
	);

	it('offers them in a filter on a text column', () => {
		expect(offeredComparators(mountNodes([{ code: { _eq: 'x' } }]))).toEqual(expect.arrayContaining(OPERATORS));
	});

	it('offers them in a validation rule on any column, which is checked without the database', () => {
		const wrapper = mountNodes([{ span: { _eq: 'x' } }], { includeValidation: true });

		expect(offeredComparators(wrapper)).toEqual(expect.arrayContaining(OPERATORS));
	});

	it('offers them in a validation rule inside a group', () => {
		const wrapper = mountNodes([{ _and: [{ span: { _eq: 'x' } }] }], { includeValidation: true });

		expect(offeredComparators(wrapper)).toEqual(expect.arrayContaining([...OPERATORS, '_regex']));
	});
});

describe('changing the field of a rule', () => {
	it.each([
		['code', 'span'],
		['code', 'data'],
		['owner.code', 'span'],
	])('keeps a case-insensitive %s rule when the field changes to the %s column, which rules it out', (from, to) => {
		const wrapper = mountNodes([{ [from.split('.')[0]!]: fieldRule(from, { _istarts_with: 'team_' }) }]);

		expect(changeField(wrapper, to)).toBeUndefined();
	});

	it('keeps the comparator and value of a code rule changed to the title field of the same type', () => {
		const wrapper = mountNodes([{ code: { _istarts_with: 'abc' } }]);

		expect(changeField(wrapper, 'title')).toEqual([{ title: { _istarts_with: 'abc' } }]);
	});

	it.each([
		['owner.code', { _istarts_with: 'abc' }, 'title', { title: { _contains: null } }],
		['rank', { _eq: 5 }, 'code', { code: { _contains: null } }],
		['code', { _contains: 'abc' }, 'data', { data: { _contains: null } }],
	])('resets the comparator and value of a %s rule %j changed to the %s field', (from, rule, to, expected) => {
		const wrapper = mountNodes([{ [from.split('.')[0]!]: fieldRule(from, rule) }]);

		expect(changeField(wrapper, to)).toEqual([expected]);
	});
});

describe('the field picker of a rule', () => {
	it('disables the fields whose column rules out the comparator, including ones loaded on expanding a relation', async () => {
		const disabled = await disabledPickerFields(mountNodes([{ code: { _istarts_with: 'abc' } }], { picker: true }));

		expect(disabled).toMatchObject({
			title: false,
			span: true,
			data: true,
			rank: false,
			owner: false,
			'owner.code': false,
			'owner.team.span': true,
			'owner.team.label': false,
		});
	});

	it('disables none of them for an ordinary comparator', async () => {
		const disabled = await disabledPickerFields(mountNodes([{ code: { _contains: 'abc' } }], { picker: true }));

		expect(disabled['span']).toBe(false);
		expect(disabled['owner.team.span']).toBe(false);
	});

	it('disables none of them in a validation rule', async () => {
		const wrapper = mountNodes([{ code: { _istarts_with: 'abc' } }], { includeValidation: true, picker: true });
		const disabled = await disabledPickerFields(wrapper);

		expect(disabled['span']).toBe(false);
		expect(disabled['owner.team.span']).toBe(false);
	});
});

function fieldRule(path: string, rule: Record<string, unknown>): Record<string, unknown> {
	const [, ...rest] = path.split('.');
	return rest.reduceRight<Record<string, unknown>>((inner, segment) => ({ [segment]: inner }), rule);
}
