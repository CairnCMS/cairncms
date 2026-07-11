import { describe, expect, it } from 'vitest';
import { synthesizeSettingsFields, type SettingsDeclarationMap } from './settings-fields';

const declaration: SettingsDeclarationMap = {
	preview_url: {
		type: 'string',
		scope: 'collection',
		appReadable: true,
		presentation: { interface: 'system-display-template' },
	},
	note: { type: 'string', scope: 'collection' },
};

describe('synthesizeSettingsFields presentation interface', () => {
	it('maps the template interface with the edited collection as contextual options', () => {
		const fields = synthesizeSettingsFields(declaration, 'collection', 'articles');

		const preview = fields.find((field) => field.field === 'preview_url');
		expect(preview?.meta.interface).toBe('system-display-template');
		expect(preview?.meta.options).toEqual({ collectionName: 'articles' });

		const note = fields.find((field) => field.field === 'note');
		expect(note?.meta.interface).toBe('input');
		expect(note?.meta.options).toBeUndefined();
	});

	it('falls back to a plain input without a collection', () => {
		const fields = synthesizeSettingsFields(declaration, 'collection');

		expect(fields.find((field) => field.field === 'preview_url')?.meta.interface).toBe('input');
	});

	it('never emits the template interface from global synthesis', () => {
		expect(synthesizeSettingsFields(declaration, 'global', 'articles')).toEqual([]);
	});
});
