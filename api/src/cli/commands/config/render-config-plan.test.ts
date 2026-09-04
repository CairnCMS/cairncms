import { describe, expect, it } from 'vitest';
import type { RoleDeletionImpactEntry, RoleValues, SerializedConfigPlan } from '../../../types/config.js';
import { createVerb, deleteVerb, heading, planIntro, updateVerb } from '../../presentation.js';
import {
	renderConfigPlan,
	renderDeletions,
	renderDestructiveRefusal,
	renderNoChanges,
	renderProtections,
	renderResultSummary,
} from './render-config-plan.js';

function roleValues(over: Partial<RoleValues> = {}): RoleValues {
	return {
		name: 'Role',
		icon: 'supervised_user_circle',
		description: null,
		admin_access: false,
		app_access: true,
		enforce_tfa: false,
		ip_access: null,
		...over,
	};
}

function emptyAggregates(): RoleDeletionImpactEntry[] {
	return [
		{ kind: 'presets', count: 0, bookmarks: [] },
		{ kind: 'users', suspended: [] },
		{ kind: 'sessions', active: 0 },
	];
}

function plan(over: Partial<SerializedConfigPlan> = {}): SerializedConfigPlan {
	return {
		planVersion: 2,
		manifestVersion: 1,
		changes: [],
		summary: { create: 0, update: 0, delete: 0 },
		warnings: [],
		protections: [],
		...over,
	};
}

describe('renderConfigPlan', () => {
	it('renders a mixed plan with shared presentation tokens', () => {
		const output = renderConfigPlan(
			plan({
				changes: [
					{
						kind: 'roles',
						operation: 'create',
						identity: { key: 'content-reviewer' },
						values: roleValues({ name: 'Content Reviewer' }),
					},
					{
						kind: 'roles',
						operation: 'update',
						identity: { key: 'editor' },
						fields: { name: { before: 'Editor', after: 'Managing Editor' } },
					},
					{
						kind: 'permissions',
						operation: 'delete',
						identity: { role: 'editor', collection: 'articles', action: 'delete' },
						impact: [],
					},
				],
				summary: { create: 1, update: 1, delete: 1 },
			})
		);

		expect(output).toBe(
			[
				planIntro,
				'',
				heading('Roles'),
				`  - ${createVerb()} content-reviewer`,
				`  - ${updateVerb()} editor`,
				'    - Set name to Managing Editor',
				'',
				heading('Permissions'),
				`  - ${deleteVerb()} editor / articles / delete`,
				'',
				'Plan: 1 to create, 1 to update, 1 to delete.',
			].join('\n')
		);
	});

	it('lists every affected identity under a gated role deletion, and shows every deletion', () => {
		const output = renderConfigPlan(
			plan({
				changes: [
					{
						kind: 'roles',
						operation: 'delete',
						identity: { key: 'editor' },
						impact: [
							{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
							{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'delete' } },
							{ kind: 'presets', count: 2, bookmarks: ['Draft queue', 'My articles'] },
							{ kind: 'users', suspended: ['u1', 'u2', 'u3'] },
							{ kind: 'sessions', active: 4 },
						],
					},
					{
						kind: 'roles',
						operation: 'delete',
						identity: { key: 'guest' },
						impact: emptyAggregates(),
					},
				],
				summary: { create: 0, update: 0, delete: 2 },
			})
		);

		expect(output).toBe(
			[
				planIntro,
				'',
				heading('Roles'),
				`  - ${deleteVerb()} editor`,
				'    - Permission removed: articles / read',
				'    - Permission removed: articles / delete',
				'    - Bookmark removed: Draft queue',
				'    - Bookmark removed: My articles',
				'    - User suspended: u1',
				'    - User suspended: u2',
				'    - User suspended: u3',
				'    - 4 active sessions affected',
				`  - ${deleteVerb()} guest`,
				'',
				'Plan: 0 to create, 0 to update, 2 to delete.',
			].join('\n')
		);
	});

	it('summarizes unnamed presets and uses singular wording for one session', () => {
		const output = renderConfigPlan(
			plan({
				changes: [
					{
						kind: 'roles',
						operation: 'delete',
						identity: { key: 'editor' },
						impact: [
							{ kind: 'presets', count: 3, bookmarks: ['Draft queue'] },
							{ kind: 'users', suspended: ['solo'] },
							{ kind: 'sessions', active: 1 },
						],
					},
				],
				summary: { create: 0, update: 0, delete: 1 },
			})
		);

		expect(output).toContain('    - Bookmark removed: Draft queue');
		expect(output).toContain('    - 2 unnamed presets removed');
		expect(output).toContain('    - User suspended: solo');
		expect(output).toContain('    - 1 active session affected');
	});

	it('omits impact lines that carry no removals', () => {
		const output = renderConfigPlan(
			plan({
				changes: [
					{
						kind: 'roles',
						operation: 'delete',
						identity: { key: 'editor' },
						impact: emptyAggregates(),
					},
				],
				summary: { create: 0, update: 0, delete: 1 },
			})
		);

		expect(output).toBe(
			[
				planIntro,
				'',
				heading('Roles'),
				`  - ${deleteVerb()} editor`,
				'',
				'Plan: 0 to create, 0 to update, 1 to delete.',
			].join('\n')
		);
	});

	it('renders a warnings section', () => {
		const output = renderConfigPlan(
			plan({
				warnings: [
					{
						code: 'COLLECTION_MISSING',
						kind: 'permissions',
						identity: { role: 'editor', collection: 'articles', action: 'read' },
						message: 'articles is not a known collection',
					},
				],
			})
		);

		expect(output).toBe(
			[
				planIntro,
				'',
				'Plan: 0 to create, 0 to update, 0 to delete.',
				'',
				heading('Warnings'),
				'  - articles is not a known collection',
			].join('\n')
		);
	});

	it('sanitizes control characters in identities, impact detail, and warnings', () => {
		const bel = String.fromCharCode(7);
		const tab = String.fromCharCode(9);
		const newline = String.fromCharCode(10);

		const output = renderConfigPlan(
			plan({
				changes: [
					{
						kind: 'roles',
						operation: 'delete',
						identity: { key: `content${bel}reviewer` },
						impact: [
							{
								kind: 'permissions',
								identity: { role: `content${bel}reviewer`, collection: `artic${bel}les`, action: 'read' },
							},
							{ kind: 'presets', count: 1, bookmarks: [`draft${tab}queue`] },
							{ kind: 'users', suspended: [`user${bel}one`] },
							{ kind: 'sessions', active: 0 },
						],
					},
				],
				summary: { create: 0, update: 0, delete: 1 },
				warnings: [
					{
						code: 'COLLECTION_MISSING',
						kind: 'permissions',
						identity: { role: 'editor', collection: 'articles', action: 'read' },
						message: `line1${newline}line2`,
					},
				],
			})
		);

		expect(output).toContain(`  - ${deleteVerb()} content?reviewer`);
		expect(output).toContain('    - Permission removed: artic?les / read');
		expect(output).toContain('    - Bookmark removed: draft?queue');
		expect(output).toContain('    - User suspended: user?one');
		expect(output).toContain('  - line1?line2');
	});

	it('renders reachable empty string field values and bookmark names visibly', () => {
		const output = renderConfigPlan(
			plan({
				changes: [
					{
						kind: 'roles',
						operation: 'update',
						identity: { key: 'editor' },
						fields: { description: { before: 'Legacy editor', after: '' } },
					},
					{
						kind: 'roles',
						operation: 'delete',
						identity: { key: 'guest' },
						impact: [
							{ kind: 'presets', count: 1, bookmarks: [''] },
							{ kind: 'users', suspended: [] },
							{ kind: 'sessions', active: 0 },
						],
					},
				],
				summary: { create: 0, update: 1, delete: 1 },
			})
		);

		expect(output).toContain('    - Set description to ""');
		expect(output).toContain('    - Bookmark removed: ""');
	});
});

describe('renderDestructiveRefusal', () => {
	it('uses singular wording for a single deletion', () => {
		expect(renderDestructiveRefusal(plan({ summary: { create: 0, update: 0, delete: 1 } }))).toBe(
			'Apply refused: this plan contains 1 deletion.\nReview the item above and run again with --destructive.'
		);
	});

	it('uses plural wording for multiple deletions', () => {
		expect(renderDestructiveRefusal(plan({ summary: { create: 0, update: 0, delete: 3 } }))).toBe(
			'Apply refused: this plan contains 3 deletions.\nReview the items above and run again with --destructive.'
		);
	});
});

describe('renderProtections', () => {
	function adminContinuity(contributors: SerializedConfigPlan['protections'][number]['contributors']) {
		return {
			code: 'ADMIN_CONTINUITY_REQUIRED' as const,
			message: 'Configuration must retain at least one role with administrator access.',
			contributors,
		};
	}

	it('renders one plan-wide section listing contributors and never suggests --destructive', () => {
		const output = renderProtections(
			plan({
				protections: [
					adminContinuity([
						{ kind: 'roles', operation: 'delete', identity: { key: 'administrator' } },
						{ kind: 'roles', operation: 'update', identity: { key: 'super_admin' } },
					]),
				],
			})
		);

		expect(output).toBe(
			[
				heading('Protected changes'),
				'  - Configuration must retain at least one role with administrator access.',
				'    - Deletes administrator',
				'    - Removes administrator access from super_admin',
			].join('\n')
		);

		expect(output).not.toContain('--destructive');
	});

	it('is included in the full plan output, and that output never suggests --destructive for the protection', () => {
		const output = renderConfigPlan(
			plan({
				changes: [
					{ kind: 'roles', operation: 'delete', identity: { key: 'administrator' }, impact: emptyAggregates() },
				],
				summary: { create: 0, update: 0, delete: 1 },
				protections: [adminContinuity([{ kind: 'roles', operation: 'delete', identity: { key: 'administrator' } }])],
			})
		);

		expect(output).toContain(heading('Protected changes'));
		expect(output).toContain('    - Deletes administrator');
		expect(output).not.toContain('--destructive');
	});

	it('sanitizes control characters in a contributor identity', () => {
		const bel = String.fromCharCode(7);

		const output = renderProtections(
			plan({
				protections: [adminContinuity([{ kind: 'roles', operation: 'delete', identity: { key: `admin${bel}role` } }])],
			})
		);

		expect(output).toContain('    - Deletes admin?role');
		expect(output).not.toContain(bel);
	});
});

describe('renderNoChanges', () => {
	it('prints the bare message without a view', () => {
		expect(renderNoChanges()).toBe('No changes to apply.');
	});

	it('prints the bare message for a view without warnings', () => {
		expect(renderNoChanges(plan())).toBe('No changes to apply.');
	});

	it('appends the warnings section under the message', () => {
		const output = renderNoChanges(
			plan({
				warnings: [
					{
						code: 'COLLECTION_MISSING',
						kind: 'permissions',
						identity: { role: 'editor', collection: 'articles', action: 'read' },
						message: 'articles is not a known collection',
					},
				],
			})
		);

		expect(output).toBe(
			['No changes to apply.', '', heading('Warnings'), '  - articles is not a known collection'].join('\n')
		);
	});
});

describe('renderDeletions', () => {
	it('renders role and permission identities with the delete verb', () => {
		expect(
			renderDeletions([
				{ kind: 'roles', identity: { key: 'legacy' } },
				{ kind: 'permissions', identity: { role: 'editor', collection: 'articles', action: 'read' } },
			])
		).toEqual([`    - ${deleteVerb()} legacy`, `    - ${deleteVerb()} editor / articles / read`]);
	});

	it('sanitizes control characters in a deletion identity', () => {
		const bel = String.fromCharCode(7);

		const [line] = renderDeletions([{ kind: 'roles', identity: { key: `legacy${bel}` } }]);

		expect(line).toBe(`    - ${deleteVerb()} legacy?`);
	});

	it('throws on a deletion whose kind is not managed', () => {
		expect(() => renderDeletions([{ kind: 'notakind', identity: { key: 'legacy' } } as never])).toThrow(
			/Unhandled config kind/
		);
	});
});

describe('renderResultSummary', () => {
	it('summarizes every managed kind in one line', () => {
		const summary = renderResultSummary({
			roles: { created: ['a', 'b'], updated: ['c'], deleted: [] },
			permissions: { created: 3, updated: 0, deleted: 1 },
		});

		expect(summary).toBe(
			'Config applied: 2 role(s) created, 1 role(s) updated, 3 permission(s) created, 1 permission(s) deleted'
		);
	});
});
