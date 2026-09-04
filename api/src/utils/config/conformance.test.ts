import type { PermissionsAction } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import { CONFIG_KINDS, type ConfigKind, type ConfigPermission, type ConfigRole } from '../../types/config.js';
import {
	RemoteApplyResult,
	RemoteConfigPlanChange,
	RemoteErrorExtensions,
} from '../../cli/commands/config/remote-response-schema.js';
import { buildRecordSchemas } from '../validate-desired-config.js';
import { computeKindPlan } from './diff.js';
import type { ConfigKindTypes, ConfigResourceDescriptor, KindPlan } from './descriptor.js';
import type { PermissionsKindTypes } from './handlers/permissions.js';
import type { RolesKindTypes } from './handlers/roles.js';
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

type FlatPermission = ConfigPermission & { role: string };

function permission(
	overrides: Partial<FlatPermission> & { role: string; collection: string; action: PermissionsAction }
): FlatPermission {
	return { permissions: null, validation: null, presets: null, fields: null, ...overrides };
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
};

const REPRESENTATIVE_DELETION: Record<ConfigKind, unknown> = {
	roles: { kind: 'roles', identity: { key: 'sample' } },
	permissions: { kind: 'permissions', identity: { role: 'sample', collection: 'articles', action: 'read' } },
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

	it('parses a representative destructive-refusal deletion for every managed kind', () => {
		for (const kind of listConfigKinds()) {
			expect(RemoteErrorExtensions.safeParse(destructiveExtension(REPRESENTATIVE_DELETION[kind])).success).toBe(true);
		}
	});

	it('rejects a destructive-refusal deletion whose kind is not managed', () => {
		const result = RemoteErrorExtensions.safeParse(
			destructiveExtension({ kind: 'notakind', identity: { key: 'sample' } })
		);

		expect(result.success).toBe(false);
	});
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
