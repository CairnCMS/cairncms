import { i18n } from '@/lang';
import { useRelationsStore } from '@/stores/relations';
import { createTestingPinia } from '@pinia/testing';
import { mount } from '@vue/test-utils';
import { setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Presets from './presets.vue';

const stubs = {
	'v-notice': { props: ['type'], template: '<div class="v-notice" :data-type="type"><slot /></div>' },
	'interface-input-code': true,
};

function mountPresets(presets: Record<string, any> | null) {
	return mount(Presets, {
		props: {
			permission: { collection: 'articles', action: 'create', presets } as any,
		},
		global: {
			plugins: [i18n],
			stubs,
		},
	});
}

describe('Role preset editor relational-field warnings', () => {
	beforeEach(() => {
		setActivePinia(createTestingPinia({ createSpy: vi.fn, stubActions: false }));

		// articles has two relational O2M fields, comments and tags
		useRelationsStore().getRelationsForCollection = vi.fn(
			() => [{ meta: { one_field: 'comments' } }, { meta: { one_field: 'tags' } }] as any
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function warnings(wrapper: ReturnType<typeof mountPresets>) {
		return wrapper.findAll('.v-notice[data-type="warning"]');
	}

	it('warns for a relational field whose preset uses non-empty array syntax', () => {
		const wrapper = mountPresets({ comments: [1, 2] });

		expect(warnings(wrapper)).toHaveLength(1);
		expect(warnings(wrapper)[0]!.text()).toContain('comments');
	});

	it('does not warn for a relational field configured with detailed object syntax', () => {
		const wrapper = mountPresets({ tags: { create: [], update: [], delete: [] } });

		expect(warnings(wrapper)).toHaveLength(0);
	});

	it('does not warn for a relational field whose preset is an empty array', () => {
		const wrapper = mountPresets({ comments: [] });

		expect(warnings(wrapper)).toHaveLength(0);
	});

	it('does not warn for a non-relational field', () => {
		const wrapper = mountPresets({ title: 'Hello' });

		expect(warnings(wrapper)).toHaveLength(0);
	});

	it('warns only for the relational fields among a mix of preset fields', () => {
		const wrapper = mountPresets({ comments: [1], tags: [2], title: 'Hello' });

		expect(warnings(wrapper)).toHaveLength(2);
	});
});
