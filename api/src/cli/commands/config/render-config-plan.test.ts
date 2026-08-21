import { describe, expect, it } from 'vitest';
import type { RoleDeletionImpactEntry, RoleValues, SerializedConfigPlan } from '../../../types/config.js';
import { createVerb, deleteVerb, heading, planIntro, updateVerb } from '../../presentation.js';
import { renderConfigPlan, renderRefusal } from './render-config-plan.js';

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
		planVersion: 1,
		manifestVersion: 1,
		changes: [],
		summary: { create: 0, update: 0, delete: 0 },
		warnings: [],
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

describe('renderRefusal', () => {
	it('uses singular wording for a single deletion', () => {
		expect(renderRefusal(plan({ summary: { create: 0, update: 0, delete: 1 } }))).toBe(
			'Apply refused: this plan contains 1 deletion.\nReview the item above and run again with --destructive.'
		);
	});

	it('uses plural wording for multiple deletions', () => {
		expect(renderRefusal(plan({ summary: { create: 0, update: 0, delete: 3 } }))).toBe(
			'Apply refused: this plan contains 3 deletions.\nReview the items above and run again with --destructive.'
		);
	});
});
