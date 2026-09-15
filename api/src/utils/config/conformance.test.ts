import type { PermissionsAction } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import {
	CONFIG_KINDS,
	type ConfigFolder,
	type ConfigKind,
	type ConfigPermission,
	type ConfigRole,
	type ConfigSettings,
} from '../../types/config.js';
import {
	RemoteApplyResult,
	RemoteConfigPlanChange,
	RemoteErrorExtensions,
} from '../../cli/commands/config/remote-response-schema.js';
import { buildRecordSchemas, validateConfigRecord } from '../validate-desired-config.js';
import { computeKindPlan, diffRecordValues } from './diff.js';
import type { ConfigKindTypes, ConfigResourceDescriptor, KindPlan } from './descriptor.js';
import type { FoldersKindTypes } from './handlers/folders.js';
import type { PermissionsKindTypes } from './handlers/permissions.js';
import type { RolesKindTypes } from './handlers/roles.js';
import type { SettingsKindTypes } from './handlers/settings.js';
import { getDescriptor, listConfigKinds } from './registry.js';

type ConformanceFixture<K extends ConfigKindTypes> = {
	document: K['Document'];
	documentIdentity: K['DocumentIdentity'];
	record: K['Record'];
	identity: K['Identity'];
	filenameStem: string;
	emptyDocument?: K['Document'];
	current: K['Record'][];
	desired: K['Record'][];
	expectedPlan: KindPlan<K>;
};

function role(overrides: Partial<ConfigRole> & { key: string }): ConfigRole {
	return { name: 'Role', admin_access: false, app_access: true, ...overrides };
}

function folder(overrides: Partial<ConfigFolder> & { key: string }): ConfigFolder {
	return { name: 'Folder', parent: null, ...overrides };
}

type FlatPermission = ConfigPermission & { role: string };

function permission(
	overrides: Partial<FlatPermission> & { role: string; collection: string; action: PermissionsAction }
): FlatPermission {
	return { permissions: null, validation: null, presets: null, fields: null, ...overrides };
}

function settings(overrides: Partial<ConfigSettings> = {}): ConfigSettings {
	return {
		project_name: 'CairnCMS',
		project_descriptor: null,
		project_url: null,
		default_language: 'en-US',
		project_color: null,
		public_note: null,
		custom_css: null,
		module_bar: null,
		auth_password_policy: null,
		auth_login_attempts: 25,
		storage_asset_transform: 'all',
		storage_asset_presets: null,
		basemaps: null,
		custom_aspect_ratios: null,
		mapbox_key: null,
		...overrides,
	};
}

const ROLES_FIXTURE: ConformanceFixture<RolesKindTypes> = {
	document: role({ key: 'editor', name: 'Editor' }),
	documentIdentity: { key: 'editor' },
	record: role({ key: 'editor', name: 'Editor' }),
	identity: { key: 'editor' },
	filenameStem: 'editor',
	current: [
		role({ key: 'keeper', name: 'Keeper' }),
		role({ key: 'editor', name: 'Editor' }),
		role({ key: 'legacy', name: 'Legacy' }),
	],
	desired: [
		role({ key: 'keeper', name: 'Keeper' }),
		role({ key: 'editor', name: 'Managing Editor' }),
		role({ key: 'newcomer', name: 'Newcomer' }),
	],
	expectedPlan: {
		create: [role({ key: 'newcomer', name: 'Newcomer' })],
		update: [{ key: 'editor', changes: { name: { before: 'Editor', after: 'Managing Editor' } } }],
		delete: ['legacy'],
	},
};

const PERMISSIONS_FIXTURE: ConformanceFixture<PermissionsKindTypes> = {
	document: {
		role: 'author',
		permissions: [
			{ collection: 'articles', action: 'read', permissions: null, validation: null, presets: null, fields: null },
		],
	},
	documentIdentity: { role: 'author' },
	record: permission({ role: 'author', collection: 'articles', action: 'read' }),
	identity: { role: 'author', collection: 'articles', action: 'read' },
	filenameStem: 'author',
	emptyDocument: { role: 'guest', permissions: [] },
	current: [
		permission({ role: 'editor', collection: 'articles', action: 'read', permissions: { a: 1 } }),
		permission({ role: 'editor', collection: 'articles', action: 'update' }),
	],
	desired: [
		permission({ role: 'editor', collection: 'articles', action: 'read', permissions: { a: 2 } }),
		permission({ role: 'editor', collection: 'articles', action: 'create' }),
	],
	expectedPlan: {
		create: [
			{
				roleKey: 'editor',
				permission: {
					collection: 'articles',
					action: 'create',
					permissions: null,
					validation: null,
					presets: null,
					fields: null,
				},
			},
		],
		update: [
			{
				roleKey: 'editor',
				collection: 'articles',
				action: 'read',
				changes: { permissions: { before: { a: 1 }, after: { a: 2 } } },
			},
		],
		delete: [{ roleKey: 'editor', collection: 'articles', action: 'update' }],
	},
};

const FOLDERS_FIXTURE: ConformanceFixture<FoldersKindTypes> = {
	document: folder({ key: 'docs', name: 'Docs' }),
	documentIdentity: { key: 'docs' },
	record: folder({ key: 'docs', name: 'Docs' }),
	identity: { key: 'docs' },
	filenameStem: 'docs',
	current: [
		folder({ key: 'keeper', name: 'Keeper' }),
		folder({ key: 'docs', name: 'Docs' }),
		folder({ key: 'legacy', name: 'Legacy' }),
	],
	desired: [
		folder({ key: 'keeper', name: 'Keeper' }),
		folder({ key: 'docs', name: 'Documents' }),
		folder({ key: 'newcomer', name: 'Newcomer' }),
	],
	expectedPlan: {
		create: [folder({ key: 'newcomer', name: 'Newcomer' })],
		update: [{ key: 'docs', changes: { name: { before: 'Docs', after: 'Documents' } } }],
		delete: ['legacy'],
	},
};

const SETTINGS_FIXTURE: ConformanceFixture<SettingsKindTypes> = {
	document: settings(),
	documentIdentity: { key: 'project' },
	record: settings(),
	identity: { key: 'project' },
	filenameStem: 'project',
	current: [settings()],
	desired: [settings({ project_name: 'Renamed' })],
	expectedPlan: {
		create: [],
		update: [{ changes: { project_name: { before: 'CairnCMS', after: 'Renamed' } } }],
		delete: [],
	},
};

function runConformance<K extends ConfigKindTypes>(
	descriptor: ConfigResourceDescriptor<K>,
	fixture: ConformanceFixture<K>
): void {
	it('documentIdentityOf returns the exact document identity', () => {
		expect(descriptor.layout.documentIdentityOf(fixture.document)).toEqual(fixture.documentIdentity);
	});

	it('filenameOf maps the document identity to its stem', () => {
		expect(descriptor.layout.filenameOf(fixture.documentIdentity)).toBe(fixture.filenameStem);
	});

	it('identityOf returns the exact record identity', () => {
		expect(descriptor.identityOf(fixture.record)).toEqual(fixture.identity);
	});

	it('round-trips the document and an empty input through projectDocuments/composeDocuments', () => {
		const projected = descriptor.projectDocuments([fixture.document]);
		expect(descriptor.composeDocuments(projected.records, projected.anchors)).toEqual([fixture.document]);

		const empty = descriptor.projectDocuments([]);
		expect(descriptor.composeDocuments(empty.records, empty.anchors)).toEqual([]);
	});

	const { emptyDocument } = fixture;

	if (emptyDocument !== undefined) {
		it('round-trips an empty, zero-record document', () => {
			const projected = descriptor.projectDocuments([emptyDocument]);
			expect(descriptor.composeDocuments(projected.records, projected.anchors)).toEqual([emptyDocument]);
		});
	}

	it('produces the exact create, update, and delete plan entries', () => {
		expect(computeKindPlan(descriptor, fixture.current, fixture.desired)).toEqual(fixture.expectedPlan);
	});
}

const RUNNERS = {
	roles: () => runConformance(getDescriptor('roles'), ROLES_FIXTURE),
	permissions: () => runConformance(getDescriptor('permissions'), PERMISSIONS_FIXTURE),
	folders: () => runConformance(getDescriptor('folders'), FOLDERS_FIXTURE),
	settings: () => runConformance(getDescriptor('settings'), SETTINGS_FIXTURE),
} satisfies Record<ConfigKind, () => void>;

describe.each(listConfigKinds())('descriptor conformance: %s', (kind) => {
	RUNNERS[kind]();
});

const REPRESENTATIVE_CHANGE: Record<ConfigKind, unknown> = {
	roles: {
		kind: 'roles',
		operation: 'create',
		identity: { key: 'sample' },
		values: {
			name: 'Sample',
			icon: 'badge',
			description: null,
			admin_access: false,
			app_access: true,
			enforce_tfa: false,
			ip_access: null,
		},
	},
	permissions: {
		kind: 'permissions',
		operation: 'create',
		identity: { role: 'sample', collection: 'articles', action: 'read' },
		values: { permissions: null, validation: null, presets: null, fields: null },
	},
	folders: {
		kind: 'folders',
		operation: 'create',
		identity: { key: 'sample' },
		values: { name: 'Sample', parent: null },
	},
	settings: {
		kind: 'settings',
		operation: 'update',
		identity: { key: 'project' },
		fields: { project_name: { before: 'CairnCMS', after: 'Renamed' } },
	},
};

const REPRESENTATIVE_DELETION: Partial<Record<ConfigKind, unknown>> = {
	roles: { kind: 'roles', identity: { key: 'sample' } },
	permissions: { kind: 'permissions', identity: { role: 'sample', collection: 'articles', action: 'read' } },
	folders: { kind: 'folders', identity: { key: 'sample' } },
};

function destructiveExtension(deletion: unknown): unknown {
	return { code: 'DESTRUCTIVE_CHANGES_REQUIRED', deletions: [deletion] };
}

describe('config kind wiring conformance', () => {
	const kinds = [...CONFIG_KINDS].sort();

	it('derives a record schema for exactly every managed kind', () => {
		expect(Object.keys(buildRecordSchemas()).sort()).toEqual(kinds);
	});

	it('declares a remote apply-result slice for exactly every managed kind', () => {
		expect(Object.keys(RemoteApplyResult.shape).sort()).toEqual(kinds);
	});

	it('parses a representative change for every managed kind through the remote change union', () => {
		for (const kind of listConfigKinds()) {
			expect(RemoteConfigPlanChange.safeParse(REPRESENTATIVE_CHANGE[kind]).success).toBe(true);
		}
	});

	it('rejects a change whose kind is not managed', () => {
		const result = RemoteConfigPlanChange.safeParse({
			kind: 'notakind',
			operation: 'create',
			identity: { key: 'sample' },
		});

		expect(result.success).toBe(false);
	});

	it('parses a representative destructive-refusal deletion for every deletable kind', () => {
		for (const kind of Object.keys(REPRESENTATIVE_DELETION) as ConfigKind[]) {
			expect(RemoteErrorExtensions.safeParse(destructiveExtension(REPRESENTATIVE_DELETION[kind])).success).toBe(true);
		}
	});

	it('rejects a destructive-refusal deletion whose kind is not managed', () => {
		const result = RemoteErrorExtensions.safeParse(
			destructiveExtension({ kind: 'notakind', identity: { key: 'sample' } })
		);

		expect(result.success).toBe(false);
	});

	it('rejects a settings deletion, which the singleton does not support', () => {
		const result = RemoteErrorExtensions.safeParse(
			destructiveExtension({ kind: 'settings', identity: { key: 'project' } })
		);

		expect(result.success).toBe(false);
	});
});

describe('cross-kind omission contract', () => {
	// Independently authored, not read from the descriptor, so a requiredness or omission change must update it.
	const OPTIONAL_FIELDS: Record<ConfigKind, string[]> = {
		roles: ['description', 'enforce_tfa', 'icon', 'ip_access'],
		permissions: [],
		folders: ['parent'],
		settings: [
			'auth_login_attempts',
			'auth_password_policy',
			'basemaps',
			'custom_aspect_ratios',
			'custom_css',
			'default_language',
			'mapbox_key',
			'module_bar',
			'project_color',
			'project_descriptor',
			'project_name',
			'project_url',
			'public_note',
			'storage_asset_presets',
			'storage_asset_transform',
		],
	};

	it.each(listConfigKinds())('binds omissionPreservesCurrent to optionality for every %s field', (kind) => {
		const descriptor = getDescriptor(kind);

		for (const field of [...descriptor.documentIdentityFields, ...descriptor.recordFields]) {
			expect(field.omissionPreservesCurrent).toBe(!field.required);
		}
	});

	it.each(listConfigKinds())('pins the preserve-on-omit fields of %s to an independent expectation', (kind) => {
		const descriptor = getDescriptor(kind);

		const optional = [...descriptor.documentIdentityFields, ...descriptor.recordFields]
			.filter((field) => !field.required)
			.map((field) => field.name)
			.sort();

		expect(optional).toEqual([...OPTIONAL_FIELDS[kind]].sort());
	});
});

describe('cross-kind omission behavior', () => {
	const rolesDescriptor = getDescriptor('roles');
	const foldersDescriptor = getDescriptor('folders');
	const permissionsDescriptor = getDescriptor('permissions');

	type Change = { before: unknown; after: unknown };

	function completePermissionRecord(): Record<string, unknown> {
		return { collection: 'articles', action: 'read', permissions: null, validation: null, presets: null, fields: null };
	}

	it('preserves non-default optional role values when omitted on update while a present field changes', () => {
		const current = role({
			key: 'editor',
			name: 'Editor',
			icon: 'custom_icon',
			enforce_tfa: true,
			description: 'Kept',
			ip_access: ['10.0.0.0/8'],
		});

		const changes = diffRecordValues(rolesDescriptor, current, role({ key: 'editor', name: 'Renamed' })) as Record<
			string,
			Change
		>;

		expect(Object.keys(changes)).toEqual(['name']);
		expect(changes['name']).toEqual({ before: 'Editor', after: 'Renamed' });
	});

	it('applies the literal role service defaults when optional fields are omitted on create', () => {
		const created = rolesDescriptor.canonicalizeValues(role({ key: 'fresh', name: 'Fresh' })) as Record<
			string,
			unknown
		>;

		expect(created).toMatchObject({
			icon: 'supervised_user_circle',
			enforce_tfa: false,
			description: null,
			ip_access: null,
		});
	});

	it('treats an explicit false for a security-bearing field as a change, not omission', () => {
		const changes = diffRecordValues(
			rolesDescriptor,
			role({ key: 'editor', name: 'Editor', enforce_tfa: true }),
			role({ key: 'editor', name: 'Editor', enforce_tfa: false })
		) as Record<string, Change>;

		expect(changes['enforce_tfa']).toEqual({ before: true, after: false });
	});

	it('preserves a folder parent on omitted update and roots it on omitted create', () => {
		const changes = diffRecordValues(foldersDescriptor, folder({ key: 'child', name: 'Child', parent: 'root' }), {
			key: 'child',
			name: 'Renamed',
		}) as Record<string, Change>;

		expect(Object.keys(changes)).toEqual(['name']);
		expect(changes['name']).toEqual({ before: 'Child', after: 'Renamed' });

		const created = foldersDescriptor.canonicalizeValues({ key: 'fresh', name: 'Fresh' }) as Record<string, unknown>;

		expect(created).toMatchObject({ parent: null });
	});

	it('replaces a whole permission policy object rather than merging clauses', () => {
		const changes = diffRecordValues(
			permissionsDescriptor,
			permission({ role: 'editor', collection: 'articles', action: 'read', permissions: { a: 1 } }),
			permission({ role: 'editor', collection: 'articles', action: 'read', permissions: { b: 2 } })
		) as Record<string, Change>;

		expect(changes['permissions']).toEqual({ before: { a: 1 }, after: { b: 2 } });
	});

	it('preserves non-default settings values when omitted on update while a present field changes', () => {
		const current = settings({ project_name: 'Live', auth_password_policy: '^.{12,}$', auth_login_attempts: 3 });

		const changes = diffRecordValues(getDescriptor('settings'), current, {
			project_name: 'Renamed',
		} as never) as Record<string, Change>;

		expect(Object.keys(changes)).toEqual(['project_name']);
		expect(changes['project_name']).toEqual({ before: 'Live', after: 'Renamed' });
	});

	it('treats an explicit null for a nullable settings field as a change, not omission', () => {
		const changes = diffRecordValues(
			getDescriptor('settings'),
			settings({ auth_login_attempts: 5 }),
			settings({ auth_login_attempts: null })
		) as Record<string, Change>;

		expect(changes['auth_login_attempts']).toEqual({ before: 5, after: null });
	});

	it('treats an explicit empty string as a distinct value from null on a settings field', () => {
		const changes = diffRecordValues(
			getDescriptor('settings'),
			settings({ custom_css: null }),
			settings({ custom_css: '' })
		) as Record<string, Change>;

		expect(changes['custom_css']).toEqual({ before: null, after: '' });
	});

	it.each(['action', 'permissions', 'validation', 'presets', 'fields'])(
		'rejects a permission that omits the required field %s before planning',
		(field) => {
			const record = completePermissionRecord();
			delete record[field];

			const problems = validateConfigRecord('permissions', { role: 'author', permissions: [record] });

			expect(problems.length).toBeGreaterThan(0);
			expect(problems.join(' ')).toContain(field);
		}
	);
});

describe('projectReadState mode invariant', () => {
	it('roles binds record identities and values in full mode and currentRoleKeys in identity mode', () => {
		const descriptor = getDescriptor('roles');

		const result = {
			records: [role({ key: 'editor', name: 'Editor' })],
			documentIdentities: [{ key: 'editor' }],
			dependencyState: { currentRoleKeys: new Set(['editor', 'viewer']), roleKeyById: new Map() },
		};

		const full = descriptor.handler.projectReadState(result as never, 'full');
		expect(full.mode).toBe('full');
		expect(full).toHaveProperty('values');
		expect(full.identities).toEqual(['editor']);

		const identity = descriptor.handler.projectReadState(result as never, 'identity');
		expect(identity.mode).toBe('identity');
		expect(identity).not.toHaveProperty('values');
		expect(identity.identities).toEqual(['editor', 'viewer']);
	});

	it('permissions carries record identities and values in full mode', () => {
		const descriptor = getDescriptor('permissions');

		const result = {
			records: [permission({ role: 'editor', collection: 'articles', action: 'read' })],
			documentIdentities: [{ role: 'editor' }],
			dependencyState: undefined,
		};

		const full = descriptor.handler.projectReadState(result as never, 'full');
		expect(full.mode).toBe('full');
		expect(full).toHaveProperty('values');
		expect(full.identities).toEqual([JSON.stringify(['editor', 'articles', 'read'])]);
	});

	it('permissions projection carries the full executable policy in its values', () => {
		const descriptor = getDescriptor('permissions');

		const full = descriptor.handler.projectReadState(
			{
				records: [
					permission({
						role: 'editor',
						collection: 'articles',
						action: 'read',
						permissions: { status: { _eq: 'published' } },
						validation: { owner: { _eq: '$CURRENT_USER' } },
						presets: { status: 'published' },
						fields: ['title', 'body'],
					}),
				],
				documentIdentities: [{ role: 'editor' }],
				dependencyState: undefined,
			} as never,
			'full'
		);

		expect(full.mode).toBe('full');

		expect((full as { values: Array<[string, unknown]> }).values).toEqual([
			[
				JSON.stringify(['editor', 'articles', 'read']),
				{
					permissions: { status: { _eq: 'published' } },
					validation: { owner: { _eq: '$CURRENT_USER' } },
					presets: { status: 'published' },
					fields: ['body', 'title'],
				},
			],
		]);
	});
});
