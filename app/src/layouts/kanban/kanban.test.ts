import { config, flushPromises, shallowMount } from '@vue/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { defineComponent } from 'vue';
import { createI18n } from 'vue-i18n';
import { unexpectedError } from '@/utils/unexpected-error';
import KanbanLayout from './kanban.vue';
import type { Group } from './types';

vi.mock('@/utils/unexpected-error', () => ({ unexpectedError: vi.fn() }));

const i18n = createI18n({ legacy: false });

/* eslint-disable vue/one-component-per-file */

const dialogPassthrough = defineComponent({
	name: 'VDialog',
	props: { modelValue: { type: Boolean, default: false } },
	emits: ['esc'],
	template: '<div v-if="modelValue"><slot /></div>',
});

const buttonPassthrough = defineComponent({
	name: 'VButton',
	props: {
		kind: { type: String, default: undefined },
		loading: { type: Boolean, default: false },
		disabled: { type: Boolean, default: false },
	},
	emits: ['click'],
	template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot /></button>',
});

const listItemPassthrough = defineComponent({
	name: 'VListItem',
	props: { clickable: { type: Boolean, default: false } },
	emits: ['click'],
	template: '<div @click="$emit(\'click\')"><slot /></div>',
});

// Renders the scoped item slot the real draggable provides, so the per-group menu exists.
const draggablePassthrough = defineComponent({
	name: 'Draggable',
	props: { modelValue: { type: Array as () => unknown[], default: () => [] } },
	template: '<div><template v-for="element in modelValue"><slot name="item" :element="element" /></template></div>',
});

function makeGroup(id: string | number): Group {
	return { id, title: `Group ${id}`, items: [], sort: 1 };
}

function mountKanban(deleteGroup: (id: string | number) => Promise<void>) {
	return shallowMount(KanbanLayout, {
		props: {
			collection: 'articles',
			groupedItems: [makeGroup('group-1'), makeGroup('group-2')],
			isRelational: true,
			change: vi.fn(),
			changeGroupSort: vi.fn(),
			addGroup: vi.fn(async () => undefined),
			editGroup: vi.fn(async () => undefined),
			deleteGroup,
		},
		global: {
			plugins: [i18n],
			components: {
				VDialog: dialogPassthrough,
				VButton: buttonPassthrough,
				VListItem: listItemPassthrough,
				Draggable: draggablePassthrough,
			},
			stubs: { VDialog: false, VButton: false, VListItem: false, Draggable: draggablePassthrough },
		},
	});
}

type Wrapper = ReturnType<typeof mountKanban>;

function deleteMenuItems(wrapper: Wrapper) {
	return wrapper.findAllComponents(listItemPassthrough).filter((item) => item.text().includes('delete_group'));
}

function confirmDialog(wrapper: Wrapper) {
	return wrapper.findAllComponents(dialogPassthrough).find((dialog) => dialog.props('modelValue') === true);
}

function dialogButtons(wrapper: Wrapper) {
	const dialog = confirmDialog(wrapper);
	const buttons = dialog!.findAllComponents(buttonPassthrough);

	return {
		cancel: buttons.find((button) => button.text().includes('cancel'))!,
		confirm: buttons.find((button) => button.props('kind') === 'danger')!,
	};
}

async function openDeleteDialog(wrapper: Wrapper) {
	await deleteMenuItems(wrapper)[0]!.trigger('click');
}

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;

	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});

	return { promise, resolve, reject };
}

beforeAll(() => {
	config.global.renderStubDefaultSlot = true;
});

afterAll(() => {
	config.global.renderStubDefaultSlot = false;
});

afterEach(() => {
	vi.mocked(unexpectedError).mockReset();
});

describe('kanban delete group confirmation', () => {
	test('choosing Delete Group opens the dialog without deleting anything', async () => {
		const deleteGroup = vi.fn(async () => undefined);
		const wrapper = mountKanban(deleteGroup);

		expect(confirmDialog(wrapper)).toBeUndefined();

		await openDeleteDialog(wrapper);

		expect(confirmDialog(wrapper)).toBeDefined();
		expect(confirmDialog(wrapper)!.text()).toContain('delete_are_you_sure');
		expect(deleteGroup).not.toHaveBeenCalled();
	});

	test('cancelling closes the dialog and deletes nothing', async () => {
		const deleteGroup = vi.fn(async () => undefined);
		const wrapper = mountKanban(deleteGroup);

		await openDeleteDialog(wrapper);
		await dialogButtons(wrapper).cancel.trigger('click');

		expect(confirmDialog(wrapper)).toBeUndefined();
		expect(deleteGroup).not.toHaveBeenCalled();
	});

	test('confirming deletes the chosen group exactly once', async () => {
		const deleteGroup = vi.fn(async () => undefined);
		const wrapper = mountKanban(deleteGroup);

		await openDeleteDialog(wrapper);
		await dialogButtons(wrapper).confirm.trigger('click');
		await flushPromises();

		expect(deleteGroup).toHaveBeenCalledTimes(1);
		expect(deleteGroup).toHaveBeenCalledWith('group-1');
		expect(confirmDialog(wrapper)).toBeUndefined();
	});

	test('a second confirm click while the request is pending does not submit twice', async () => {
		const pending = deferred();
		const deleteGroup = vi.fn(() => pending.promise);
		const wrapper = mountKanban(deleteGroup);

		await openDeleteDialog(wrapper);
		await dialogButtons(wrapper).confirm.trigger('click');
		await dialogButtons(wrapper).confirm.trigger('click');

		expect(deleteGroup).toHaveBeenCalledTimes(1);

		pending.resolve();
		await flushPromises();
	});

	test('both dialog buttons show their pending state while the request is in flight', async () => {
		const pending = deferred();
		const deleteGroup = vi.fn(() => pending.promise);
		const wrapper = mountKanban(deleteGroup);

		await openDeleteDialog(wrapper);

		expect(dialogButtons(wrapper).confirm.props('loading')).toBe(false);
		expect(dialogButtons(wrapper).confirm.props('disabled')).toBe(false);
		expect(dialogButtons(wrapper).cancel.props('disabled')).toBe(false);

		await dialogButtons(wrapper).confirm.trigger('click');

		expect(dialogButtons(wrapper).confirm.props('loading')).toBe(true);
		expect(dialogButtons(wrapper).confirm.props('disabled')).toBe(true);
		expect(dialogButtons(wrapper).cancel.props('disabled')).toBe(true);

		pending.resolve();
		await flushPromises();
	});

	test('Escape closes an idle dialog', async () => {
		const deleteGroup = vi.fn(async () => undefined);
		const wrapper = mountKanban(deleteGroup);

		await openDeleteDialog(wrapper);
		confirmDialog(wrapper)!.vm.$emit('esc');
		await flushPromises();

		expect(confirmDialog(wrapper)).toBeUndefined();
		expect(deleteGroup).not.toHaveBeenCalled();
	});

	test('a rejected deletion reports the error and restores a usable dialog', async () => {
		const pending = deferred();
		const deleteGroup = vi.fn(() => pending.promise);
		const wrapper = mountKanban(deleteGroup);

		await openDeleteDialog(wrapper);
		await dialogButtons(wrapper).confirm.trigger('click');

		const failure = new Error('forbidden');
		pending.reject(failure);
		await flushPromises();

		expect(unexpectedError).toHaveBeenCalledWith(failure);
		expect(confirmDialog(wrapper)).toBeUndefined();

		await openDeleteDialog(wrapper);

		expect(dialogButtons(wrapper).confirm.props('loading')).toBe(false);
	});

	test('cancelling is inert while the deletion is pending', async () => {
		const pending = deferred();
		const deleteGroup = vi.fn(() => pending.promise);
		const wrapper = mountKanban(deleteGroup);

		await openDeleteDialog(wrapper);
		await dialogButtons(wrapper).confirm.trigger('click');

		await dialogButtons(wrapper).cancel.trigger('click');
		confirmDialog(wrapper)!.vm.$emit('esc');
		await flushPromises();

		expect(confirmDialog(wrapper)).toBeDefined();

		pending.resolve();
		await flushPromises();
	});
});
