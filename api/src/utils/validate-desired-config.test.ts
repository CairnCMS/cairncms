import { describe, expect, it } from 'vitest';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { ConfigUnsupportedVersionException } from '../exceptions/config-unsupported-version.js';
import type { ConfigKind, ConfigManifest } from '../types/config.js';
import { validateConfigManifest, validateConfigRecord, validateDesiredConfig } from './validate-desired-config.js';

function manifest(resources: ConfigKind[] = ['roles', 'permissions']): ConfigManifest {
	return { version: 1, resources };
}

function role(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { key: 'editor', name: 'Editor', admin_access: false, app_access: true, ...overrides };
}

function permission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		collection: 'articles',
		action: 'read',
		permissions: null,
		validation: null,
		presets: null,
		fields: null,
		...overrides,
	};
}

function permissionSet(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { role: 'editor', permissions: [permission()], ...overrides };
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return { manifest: manifest(), roles: [role()], permissions: [permissionSet()], ...overrides };
}

function validate(doc: Record<string, unknown>, currentRoleKeys: string[] = []): string[] {
	return validateDesiredConfig(doc, { label: 'test', currentRoleKeys: new Set(currentRoleKeys) });
}

describe('validateConfigManifest', () => {
	it('returns the declaration when it is valid', () => {
		expect(validateConfigManifest({ version: 1, resources: ['roles'] }, 'test')).toEqual({
			version: 1,
			resources: ['roles'],
		});
	});

	it('accepts an empty resource list as managing nothing', () => {
		expect(validateConfigManifest({ version: 1, resources: [] }, 'test')).toEqual({ version: 1, resources: [] });
	});

	it('raises the unsupported-version code for a newer version', () => {
		expect(() => validateConfigManifest({ version: 2, resources: [] }, 'test')).toThrow(
			ConfigUnsupportedVersionException
		);
	});

	it('raises the unsupported-version code when no version is declared', () => {
		expect(() => validateConfigManifest({ resources: [] }, 'test')).toThrow(ConfigUnsupportedVersionException);
	});

	it('rejects a manifest that is not a mapping', () => {
		expect(() => validateConfigManifest(['roles'], 'test')).toThrow(ConfigInvalidException);
	});

	it('rejects a resource that is not a supported kind', () => {
		expect(() => validateConfigManifest({ version: 1, resources: ['flows'] }, 'test')).toThrow(ConfigInvalidException);
	});

	it('rejects a repeated resource', () => {
		expect(() => validateConfigManifest({ version: 1, resources: ['roles', 'roles'] }, 'test')).toThrow(
			ConfigInvalidException
		);
	});

	it('rejects a missing resource list', () => {
		expect(() => validateConfigManifest({ version: 1 }, 'test')).toThrow(ConfigInvalidException);
	});

	it('rejects an unknown manifest key', () => {
		expect(() => validateConfigManifest({ version: 1, resources: [], mode: 'merge' }, 'test')).toThrow(
			ConfigInvalidException
		);
	});
});

describe('validateDesiredConfig', () => {
	it('accepts a document that satisfies the contract', () => {
		expect(validate(document())).toEqual([]);
	});

	it('rejects a string where a boolean belongs, so no value is coerced into an access grant', () => {
		const errors = validate(document({ roles: [role({ admin_access: 'false' })] }));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('admin_access');
	});

	it('accepts operator-authored filters, validation, and presets inside policy objects', () => {
		const errors = validate(
			document({
				permissions: [
					permissionSet({
						permissions: [
							permission({
								permissions: { _and: [{ owner: { _eq: '$CURRENT_USER' } }] },
								validation: { status: { _in: ['draft', 'published'] } },
								presets: { status: 'draft', 'nested.field': 1 },
								fields: ['title', 'body'],
							}),
						],
					}),
				],
			})
		);

		expect(errors).toEqual([]);
	});

	it('rejects a policy value that is an array', () => {
		expect(
			validate(document({ permissions: [permissionSet({ permissions: [permission({ presets: [] })] })] }))
		).toHaveLength(1);
	});

	it('rejects a policy value that is a scalar', () => {
		expect(
			validate(document({ permissions: [permissionSet({ permissions: [permission({ validation: 'draft' })] })] }))
		).toHaveLength(1);
	});

	it('rejects an unknown key on a role', () => {
		expect(validate(document({ roles: [role({ admin_acess: true })] }))).toHaveLength(1);
	});

	it('rejects an unknown key on a permission set', () => {
		expect(validate(document({ permissions: [permissionSet({ collection: 'articles' })] }))).toHaveLength(1);
	});

	it('rejects an unknown key on a permission', () => {
		expect(
			validate(document({ permissions: [permissionSet({ permissions: [permission({ field: ['title'] })] })] }))
		).toHaveLength(1);
	});

	it('rejects an unknown top-level key', () => {
		expect(validate(document({ folders: [] }))).toHaveLength(1);
	});

	it('rejects a role key that fails the key grammar', () => {
		expect(validate(document({ roles: [role({ key: 'Editor Role' })] }))).toHaveLength(1);
	});

	it('rejects a role key longer than the stored column', () => {
		expect(validate(document({ roles: [role({ key: 'e'.repeat(256) })] }))).toHaveLength(1);
	});

	it('rejects an empty role key, which the key grammar alone accepts', () => {
		const errors = validate(document({ roles: [role({ key: '' })], permissions: [] }));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('key');
	});

	it('rejects "public" as a role key', () => {
		const errors = validate(document({ roles: [role({ key: 'public' })], permissions: [] }));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('reserved');
	});

	it('accepts "public" as a permission subject with no role declared for it', () => {
		expect(validate(document({ roles: [], permissions: [permissionSet({ role: 'public' })] }))).toEqual([]);
	});

	it('accepts empty display values', () => {
		expect(validate(document({ roles: [role({ name: '', icon: '', description: '' })] }))).toEqual([]);
	});

	it('accepts an empty element in a stored list, which a stored comma-separated column produces', () => {
		const errors = validate(
			document({
				roles: [role({ ip_access: ['10.0.0.1', ''] })],
				permissions: [permissionSet({ permissions: [permission({ fields: ['title', ''] })] })],
			})
		);

		expect(errors).toEqual([]);
	});

	it('rejects an empty collection', () => {
		expect(
			validate(document({ permissions: [permissionSet({ permissions: [permission({ collection: '' })] })] }))
		).toHaveLength(1);
	});

	it('rejects an empty permission subject', () => {
		expect(validate(document({ permissions: [permissionSet({ role: '' })] }))).toHaveLength(1);
	});

	it('rejects a name longer than the stored column', () => {
		expect(validate(document({ roles: [role({ name: 'n'.repeat(101) })] }))).toHaveLength(1);
	});

	it('rejects an icon longer than the stored column', () => {
		expect(validate(document({ roles: [role({ icon: 'i'.repeat(31) })] }))).toHaveLength(1);
	});

	it('rejects a collection longer than the stored column', () => {
		expect(
			validate(
				document({ permissions: [permissionSet({ permissions: [permission({ collection: 'c'.repeat(65) })] })] })
			)
		).toHaveLength(1);
	});

	it('accepts a null description', () => {
		expect(validate(document({ roles: [role({ description: null })] }))).toEqual([]);
	});

	it('rejects a null icon, which the column does not accept', () => {
		expect(validate(document({ roles: [role({ icon: null })] }))).toHaveLength(1);
	});

	it('rejects a null enforce_tfa, which the column does not accept', () => {
		expect(validate(document({ roles: [role({ enforce_tfa: null })] }))).toHaveLength(1);
	});

	it('rejects an unsupported action', () => {
		expect(
			validate(document({ permissions: [permissionSet({ permissions: [permission({ action: 'publish' })] })] }))
		).toHaveLength(1);
	});

	it('rejects duplicate role keys', () => {
		const errors = validate(document({ roles: [role(), role({ name: 'Second' })] }));

		expect(errors).toEqual(['Duplicate role "editor".']);
	});

	it('rejects two permission sets for the same role', () => {
		const errors = validate(document({ permissions: [permissionSet(), permissionSet()] }));

		expect(errors).toEqual(['Duplicate permission set for role "editor".']);
	});

	it('rejects the same collection and action twice in one set', () => {
		const errors = validate(document({ permissions: [permissionSet({ permissions: [permission(), permission()] })] }));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain('articles');
	});

	it('resolves a permission subject only against the tree when roles are managed', () => {
		const errors = validate(document({ roles: [], permissions: [permissionSet()] }), ['editor']);

		expect(errors).toEqual(['Permission set references role "editor", which no role file declares.']);
	});

	it('resolves a permission subject against the database when roles are unmanaged', () => {
		const doc = document({ manifest: manifest(['permissions']), roles: [], permissions: [permissionSet()] });

		expect(validate(doc, ['editor'])).toEqual([]);
	});

	it('rejects a permission subject that exists in neither the tree nor the database', () => {
		const doc = document({ manifest: manifest(['permissions']), roles: [], permissions: [permissionSet()] });

		expect(validate(doc)).toEqual(['Permission set references role "editor", which does not exist in the database.']);
	});

	it('takes scope from the document, so a declared kind is the only thing validation follows', () => {
		const doc = document({ manifest: manifest(['permissions']), roles: [], permissions: [permissionSet()] });

		expect(validate(doc, ['editor'])).toEqual([]);

		expect(validate({ ...doc, manifest: manifest(['roles', 'permissions']) }, ['editor'])).toEqual([
			'Permission set references role "editor", which no role file declares.',
		]);
	});

	it('throws when the document declares no manifest at all', () => {
		const { manifest: _omitted, ...withoutManifest } = document();

		expect(() => validate(withoutManifest)).toThrow(ConfigInvalidException);
	});

	it('ignores malformed records belonging to an unmanaged kind', () => {
		const doc = document({
			manifest: manifest(['permissions']),
			roles: [{ key: 'Bad Key', name: 42, bogus: true }],
			permissions: [permissionSet()],
		});

		expect(validate(doc, ['editor'])).toEqual([]);
	});

	it('ignores duplicate records belonging to an unmanaged kind', () => {
		const doc = document({ manifest: manifest(['permissions']), roles: [role(), role()] });

		expect(validate(doc, ['editor'])).toEqual([]);
	});

	it('ignores malformed and duplicate records when permissions are the unmanaged kind', () => {
		const doc = document({
			manifest: manifest(['roles']),
			permissions: [
				permissionSet({ permissions: [permission({ action: 'publish' }), permission({ collection: '' })] }),
				permissionSet(),
			],
		});

		expect(validate(doc)).toEqual([]);
	});

	it('ignores an unmanaged kind when resolving references, so the database stays authoritative', () => {
		const doc = document({ manifest: manifest(['permissions']), roles: [role()], permissions: [permissionSet()] });

		expect(validate(doc)).toEqual(['Permission set references role "editor", which does not exist in the database.']);
	});

	it('collapses control characters in a diagnostic built from an operator-authored key', () => {
		const hostile = `${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`;
		const errors = validate(document({ roles: [role({ [hostile]: 1 })] }));

		expect(errors).toHaveLength(1);
		expect(errors[0]).not.toContain(String.fromCharCode(27));
		expect(errors[0]).toContain('?[31mred');
	});

	it('keeps a long diagnostic whole rather than truncating its tail', () => {
		const longKey = 'k'.repeat(300);
		const errors = validate(document({ roles: [role({ [longKey]: 1 })] }));

		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(longKey);
		expect(errors[0]).not.toContain('...');
	});

	it('collapses control characters in a duplicate-collection diagnostic', () => {
		const hostile = `articles${String.fromCharCode(7)}`;

		const errors = validate(
			document({
				permissions: [
					permissionSet({
						permissions: [permission({ collection: hostile }), permission({ collection: hostile })],
					}),
				],
			})
		);

		expect(errors).toHaveLength(1);
		expect(errors[0]).not.toContain(String.fromCharCode(7));
	});

	it('reports every field failure in one pass', () => {
		const errors = validate(
			document({
				roles: [role({ key: 'Bad Key' }), role({ name: 'n'.repeat(101) })],
				permissions: [permissionSet({ permissions: [permission({ action: 'publish' })] })],
			})
		);

		expect(errors).toEqual([
			'"roles[0].key" must be lowercase alphanumeric with underscores, and cannot start with a digit or underscore.',
			'"roles[1].name" length must be less than or equal to 100 characters long',
			'"permissions[0].permissions[0].action" must be one of [create, read, update, delete, comment, explain, share]',
		]);
	});

	it('reports every cross-record failure in one pass', () => {
		const errors = validate(
			document({
				roles: [role(), role()],
				permissions: [permissionSet({ role: 'ghost' })],
			})
		);

		expect(errors).toEqual([
			'Duplicate role "editor".',
			'Permission set references role "ghost", which no role file declares.',
		]);
	});
});

describe('validateConfigRecord', () => {
	it('accepts a role record on its own', () => {
		expect(validateConfigRecord('roles', role())).toEqual([]);
	});

	it('accepts a permission set record on its own', () => {
		expect(validateConfigRecord('permissions', permissionSet())).toEqual([]);
	});

	it('reports a field failure in a single record', () => {
		expect(validateConfigRecord('roles', role({ name: 42 }))).toHaveLength(1);
	});

	it('leaves reference resolution to the document, so an undeclared subject passes', () => {
		expect(validateConfigRecord('permissions', permissionSet({ role: 'ghost' }))).toEqual([]);
	});
});
