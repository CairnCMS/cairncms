import type { Extension } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import {
	resolveSettingsSubjects,
	safeExtensionName,
	SETTINGS_SUBJECT_CONFIG_COLLISION,
	SETTINGS_SUBJECT_DUPLICATE,
	SETTINGS_SUBJECT_INVALID,
} from './settings-subjects.js';

const declaration = { preview_url: { type: 'string', scope: 'global' } } as any;
const configDecl = { api_key: { type: 'string', scope: 'global', secret: { source: 'config' } } } as any;

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

describe('resolveSettingsSubjects', () => {
	it('marks a declared owner with a valid unique subject eligible', () => {
		const owner = makeExtension('cairncms-extension-preview', { settings: declaration });

		const statuses = resolveSettingsSubjects([owner]);

		expect(statuses.get(owner)).toEqual({ eligible: true });
	});

	it('marks an owner with an invalid subject ineligible, and it would still load', () => {
		const owner = makeExtension('my-extension', { settings: declaration });

		const status = resolveSettingsSubjects([owner]).get(owner);

		expect(status?.eligible).toBe(false);
		expect(status?.eligible === false && status.reason.code).toBe(SETTINGS_SUBJECT_INVALID);
	});

	it('sanitizes a control-character subject so the refusal reason is safe to log', () => {
		const owner = makeExtension(`cairncms-extension-${String.fromCharCode(10)}evil`, { settings: declaration });

		const status = resolveSettingsSubjects([owner]).get(owner);

		expect(status?.eligible).toBe(false);
		const detail = status?.eligible === false ? status.reason.detail : '';
		expect(detail.includes(String.fromCharCode(10))).toBe(false);
		expect(detail).toContain('?');
	});

	it('marks every owner ineligible on a subject collision', () => {
		const first = makeExtension('cairncms-extension-dup', { settings: declaration, path: '/a' });
		const second = makeExtension('cairncms-extension-dup', { settings: declaration, path: '/b' });

		const statuses = resolveSettingsSubjects([first, second]);

		const firstStatus = statuses.get(first);
		const secondStatus = statuses.get(second);
		expect(firstStatus?.eligible === false && firstStatus.reason.code).toBe(SETTINGS_SUBJECT_DUPLICATE);
		expect(secondStatus?.eligible === false && secondStatus.reason.code).toBe(SETTINGS_SUBJECT_DUPLICATE);
	});

	it('ignores a non-owner that shares the owner subject', () => {
		const owner = makeExtension('cairncms-extension-shared', { settings: declaration, path: '/a' });
		const nonOwner = makeExtension('cairncms-extension-shared', { path: '/b' });

		const statuses = resolveSettingsSubjects([owner, nonOwner]);

		expect(statuses.get(owner)).toEqual({ eligible: true });
		expect(statuses.has(nonOwner)).toBe(false);
	});

	it('does not treat an extension without a settings declaration as an owner', () => {
		const plain = makeExtension('cairncms-extension-plain');

		const statuses = resolveSettingsSubjects([plain]);

		expect(statuses.has(plain)).toBe(false);
	});

	it('leaves a lone config-secret owner eligible', () => {
		const owner = makeExtension('@acme/cairncms-extension-stripe-sync', { settings: configDecl });

		expect(resolveSettingsSubjects([owner]).get(owner)).toEqual({ eligible: true });
	});

	it('fails both owners of a shared config variable, the variable in the log detail only', () => {
		const first = makeExtension('@acme/cairncms-extension-stripe-sync', { settings: configDecl, path: '/a' });
		const second = makeExtension('@acme/cairncms-extension-stripe.sync', { settings: configDecl, path: '/b' });

		const statuses = resolveSettingsSubjects([first, second]);

		const firstStatus = statuses.get(first);
		const secondStatus = statuses.get(second);
		expect(firstStatus?.eligible === false && firstStatus.reason.code).toBe(SETTINGS_SUBJECT_CONFIG_COLLISION);
		expect(secondStatus?.eligible === false && secondStatus.reason.code).toBe(SETTINGS_SUBJECT_CONFIG_COLLISION);

		const detail = firstStatus?.eligible === false ? firstStatus.reason.detail : '';
		expect(detail).not.toContain('CAIRNCMS_EXT_');
		expect(detail).toContain('@acme/cairncms-extension-stripe.sync');

		const logDetail = firstStatus?.eligible === false ? firstStatus.logDetail : undefined;
		expect(logDetail).toContain('CAIRNCMS_EXT_ACME_STRIPE_SYNC_API_KEY');
		expect(logDetail).toContain('@acme/cairncms-extension-stripe.sync');
	});

	it('collides an app-only owner with a confined-server owner over the full owner set', () => {
		const appOwner = makeExtension('@acme/cairncms-extension-stripe-sync', {
			settings: configDecl,
			path: '/a',
			type: 'interface',
		});

		const serverOwner = makeExtension('@acme/cairncms-extension-stripe.sync', {
			settings: configDecl,
			path: '/b',
			type: 'endpoint',
		});

		const statuses = resolveSettingsSubjects([appOwner, serverOwner]);

		expect(statuses.get(appOwner)?.eligible).toBe(false);
		expect(statuses.get(serverOwner)?.eligible).toBe(false);
	});

	it('leaves alike namespaces with different config keys eligible', () => {
		const first = makeExtension('@acme/cairncms-extension-stripe-sync', {
			settings: { alpha_key: { type: 'string', scope: 'global', secret: { source: 'config' } } } as any,
			path: '/a',
		});

		const second = makeExtension('@acme/cairncms-extension-stripe.sync', {
			settings: { beta_key: { type: 'string', scope: 'global', secret: { source: 'config' } } } as any,
			path: '/b',
		});

		const statuses = resolveSettingsSubjects([first, second]);

		expect(statuses.get(first)).toEqual({ eligible: true });
		expect(statuses.get(second)).toEqual({ eligible: true });
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
