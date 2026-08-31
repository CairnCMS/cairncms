import type { PermissionsAction } from '@cairncms/types';
import { describe, expect, it } from 'vitest';
import type { ConfigKind, ConfigPermission, ConfigRole } from '../../types/config.js';
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
