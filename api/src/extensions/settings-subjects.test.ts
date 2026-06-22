import type { Extension } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import {
	type ConfinedCapabilitiesLookup,
	resolveSettingsSubjects,
	safeExtensionName,
	SETTINGS_SUBJECT_DUPLICATE,
	SETTINGS_SUBJECT_INVALID,
} from './settings-subjects.js';

const declaration = { preview_url: { type: 'string', scope: 'global' } } as any;

function makeExtension(name: string, overrides: Partial<Extension> = {}): Extension {
	return {
		path: `/extensions/${name}`,
		name,
		local: false,
		type: 'interface',
		entrypoint: 'index.js',
		...overrides,
	} as Extension;
}

const noConfined: ConfinedCapabilitiesLookup = () => undefined;

describe('resolveSettingsSubjects', () => {
	it('marks a declared owner with a valid unique subject eligible', () => {
		const owner = makeExtension('cairncms-extension-preview', { settings: declaration });

		const statuses = resolveSettingsSubjects([owner], noConfined);

		expect(statuses.get(owner)).toEqual({ eligible: true });
	});

	it('marks an owner with an invalid subject ineligible, and it would still load', () => {
		const owner = makeExtension('my-extension', { settings: declaration });

		const status = resolveSettingsSubjects([owner], noConfined).get(owner);

		expect(status?.eligible).toBe(false);
		expect(status?.eligible === false && status.reason.code).toBe(SETTINGS_SUBJECT_INVALID);
	});

	it('sanitizes a control-character subject so the refusal reason is safe to log', () => {
		const owner = makeExtension(`cairncms-extension-${String.fromCharCode(10)}evil`, { settings: declaration });

		const status = resolveSettingsSubjects([owner], noConfined).get(owner);

		expect(status?.eligible).toBe(false);
		const detail = status?.eligible === false ? status.reason.detail : '';
		expect(detail.includes(String.fromCharCode(10))).toBe(false);
		expect(detail).toContain('?');
	});

	it('marks every owner ineligible on a subject collision', () => {
		const first = makeExtension('cairncms-extension-dup', { settings: declaration, path: '/a' });
		const second = makeExtension('cairncms-extension-dup', { settings: declaration, path: '/b' });

		const statuses = resolveSettingsSubjects([first, second], noConfined);

		const firstStatus = statuses.get(first);
		const secondStatus = statuses.get(second);
		expect(firstStatus?.eligible === false && firstStatus.reason.code).toBe(SETTINGS_SUBJECT_DUPLICATE);
		expect(secondStatus?.eligible === false && secondStatus.reason.code).toBe(SETTINGS_SUBJECT_DUPLICATE);
	});

	it('ignores a non-owner that shares the owner subject', () => {
		const owner = makeExtension('cairncms-extension-shared', { settings: declaration, path: '/a' });
		const nonOwner = makeExtension('cairncms-extension-shared', { path: '/b' });

		const statuses = resolveSettingsSubjects([owner, nonOwner], noConfined);

		expect(statuses.get(owner)).toEqual({ eligible: true });
		expect(statuses.has(nonOwner)).toBe(false);
	});

	it('treats a bundle with several settings-capable entries as one owner, never a self-collision', () => {
		const bundle = makeExtension('cairncms-extension-bundle', {
			type: 'bundle',
			entrypoint: { app: 'app.js', api: 'api.js' },
			entries: [],
		});

		const confined: ConfinedCapabilitiesLookup = (extension) =>
			extension === bundle ? { entries: { one: { settings: ['read'] }, two: { settings: ['write'] } } } : undefined;

		expect(resolveSettingsSubjects([bundle], confined).get(bundle)).toEqual({ eligible: true });
	});

	it('treats a confined capabilities.settings entry as an owner without a declaration', () => {
		const confinedApi = makeExtension('cairncms-extension-confined', { type: 'endpoint' });

		const confined: ConfinedCapabilitiesLookup = (extension) =>
			extension === confinedApi ? { self: { settings: ['write'] } } : undefined;

		expect(resolveSettingsSubjects([confinedApi], confined).get(confinedApi)).toEqual({ eligible: true });
	});

	it('does not treat an extension with neither a declaration nor a settings capability as an owner', () => {
		const plain = makeExtension('cairncms-extension-plain');

		const statuses = resolveSettingsSubjects([plain], noConfined);

		expect(statuses.has(plain)).toBe(false);
	});
});

describe('safeExtensionName', () => {
	it('replaces control characters and truncates an overlong name', () => {
		expect(safeExtensionName(`a${String.fromCharCode(10)}b${String.fromCharCode(0)}c`)).toBe('a?b?c');
		expect(safeExtensionName('x'.repeat(100))).toBe(`${'x'.repeat(64)}...`);
	});

	it('leaves a conventional name unchanged', () => {
		expect(safeExtensionName('cairncms-extension-preview')).toBe('cairncms-extension-preview');
	});
});
