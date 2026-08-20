import { describe, expect, it } from 'vitest';
import type { ConfigPermission, ConfigRole } from '../types/config.js';
import { canonicalizePermission, canonicalizeRole } from './canonicalize-config-record.js';

describe('canonicalizeRole', () => {
	it('resolves omitted optional fields to their defaults', () => {
		const role: ConfigRole = { key: 'editor', name: 'Editor', admin_access: false, app_access: true };

		expect(canonicalizeRole(role)).toEqual({
			name: 'Editor',
			icon: 'supervised_user_circle',
			description: null,
			admin_access: false,
			app_access: true,
			enforce_tfa: false,
			ip_access: null,
		});
	});

	it('preserves provided optional values', () => {
		const role: ConfigRole = {
			key: 'editor',
			name: 'Editor',
			icon: 'edit',
			description: 'desc',
			admin_access: true,
			app_access: true,
			enforce_tfa: true,
			ip_access: ['10.0.0.0/8'],
		};

		expect(canonicalizeRole(role)).toEqual({
			name: 'Editor',
			icon: 'edit',
			description: 'desc',
			admin_access: true,
			app_access: true,
			enforce_tfa: true,
			ip_access: ['10.0.0.0/8'],
		});
	});

	it('sorts ip_access so equivalent sets compare equal', () => {
		const role: ConfigRole = {
			key: 'editor',
			name: 'Editor',
			admin_access: false,
			app_access: true,
			ip_access: ['10.0.0.2', '10.0.0.1'],
		};

		expect(canonicalizeRole(role).ip_access).toEqual(['10.0.0.1', '10.0.0.2']);
	});

	it('does not mutate the input ip_access array', () => {
		const ipAccess = ['10.0.0.2', '10.0.0.1'];
		canonicalizeRole({ key: 'editor', name: 'Editor', admin_access: false, app_access: true, ip_access: ipAccess });

		expect(ipAccess).toEqual(['10.0.0.2', '10.0.0.1']);
	});
});

describe('canonicalizePermission', () => {
	it('carries the four value fields and drops identity', () => {
		const permission: ConfigPermission = {
			collection: 'articles',
			action: 'read',
			permissions: { _and: [] },
			validation: null,
			presets: { status: 'draft' },
			fields: ['title'],
		};

		expect(canonicalizePermission(permission)).toEqual({
			permissions: { _and: [] },
			validation: null,
			presets: { status: 'draft' },
			fields: ['title'],
		});
	});

	it('sorts fields so equivalent sets compare equal', () => {
		const permission: ConfigPermission = {
			collection: 'articles',
			action: 'read',
			permissions: null,
			validation: null,
			presets: null,
			fields: ['title', 'body'],
		};

		expect(canonicalizePermission(permission).fields).toEqual(['body', 'title']);
	});

	it('does not mutate the input fields array', () => {
		const fields = ['title', 'body'];

		canonicalizePermission({
			collection: 'articles',
			action: 'read',
			permissions: null,
			validation: null,
			presets: null,
			fields,
		});

		expect(fields).toEqual(['title', 'body']);
	});
});
