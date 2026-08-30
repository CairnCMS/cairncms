import type { ConfigPlanChange, RoleDeletionImpactEntry, SerializedConfigPlan } from '../../../types/config.js';
import { replaceControlCharacters } from '../../../utils/safe-log-fragment.js';
import { createVerb, deleteVerb, heading, planIntro, updateVerb } from '../../presentation.js';

export function renderConfigPlan(serialized: SerializedConfigPlan): string {
	const lines: string[] = [planIntro];
	let currentKind: 'roles' | 'permissions' | null = null;

	for (const change of serialized.changes) {
		if (change.kind !== currentKind) {
			currentKind = change.kind;
			lines.push('', heading(change.kind === 'roles' ? 'Roles' : 'Permissions'));
		}

		lines.push(...renderChange(change));
	}

	const { create, update, delete: remove } = serialized.summary;
	lines.push('', `Plan: ${create} to create, ${update} to update, ${remove} to delete.`);

	const protections = renderProtections(serialized);
	if (protections) lines.push('', protections);

	const warnings = renderWarnings(serialized);
	if (warnings) lines.push('', warnings);

	return lines.join('\n');
}

export function renderProtections(serialized: SerializedConfigPlan): string {
	if (serialized.protections.length === 0) return '';

	const lines = [heading('Protected changes')];

	for (const protection of serialized.protections) {
		lines.push(`  - ${replaceControlCharacters(protection.message)}`);

		for (const contributor of protection.contributors) {
			const verb = contributor.operation === 'delete' ? 'Deletes' : 'Removes administrator access from';
			lines.push(`    - ${verb} ${replaceControlCharacters(contributor.identity.key)}`);
		}
	}

	return lines.join('\n');
}

export function renderWarnings(serialized: SerializedConfigPlan): string {
	if (serialized.warnings.length === 0) return '';

	const lines = [heading('Warnings')];

	for (const warning of serialized.warnings) {
		lines.push(`  - ${replaceControlCharacters(warning.message)}`);
	}

	return lines.join('\n');
}

export function renderDestructiveRefusal(serialized: SerializedConfigPlan): string {
	const count = serialized.summary.delete;
	const noun = count === 1 ? 'deletion' : 'deletions';
	const subject = count === 1 ? 'item' : 'items';

	return `Apply refused: this plan contains ${count} ${noun}.\nReview the ${subject} above and run again with --destructive.`;
}

function renderChange(change: ConfigPlanChange): string[] {
	const identity = renderIdentity(change);

	if (change.operation === 'create') {
		return [`  - ${createVerb()} ${identity}`];
	}

	if (change.operation === 'update') {
		const lines = [`  - ${updateVerb()} ${identity}`];

		for (const [field, fieldChange] of Object.entries(change.fields)) {
			lines.push(`    - Set ${field} to ${renderValue(fieldChange!.after)}`);
		}

		return lines;
	}

	const lines = [`  - ${deleteVerb()} ${identity}`];

	if (change.kind === 'roles') {
		lines.push(...renderImpact(change.impact));
	}

	return lines;
}

function renderIdentity(change: ConfigPlanChange): string {
	if (change.kind === 'roles') {
		return replaceControlCharacters(change.identity.key);
	}

	const { role, collection, action } = change.identity;
	return `${replaceControlCharacters(role)} / ${replaceControlCharacters(collection)} / ${replaceControlCharacters(
		action
	)}`;
}

function renderValue(value: unknown): string {
	if (typeof value === 'string') return displayString(value);
	return JSON.stringify(value);
}

function displayString(value: string): string {
	return value === '' ? '""' : replaceControlCharacters(value);
}

function renderImpact(impact: RoleDeletionImpactEntry[]): string[] {
	const lines: string[] = [];

	for (const entry of impact) {
		if (entry.kind === 'permissions') {
			const { collection, action } = entry.identity;

			lines.push(
				`    - Permission removed: ${replaceControlCharacters(collection)} / ${replaceControlCharacters(action)}`
			);
		}
	}

	const presets = impact.find(
		(entry): entry is Extract<RoleDeletionImpactEntry, { kind: 'presets' }> => entry.kind === 'presets'
	);

	if (presets) {
		for (const bookmark of presets.bookmarks) {
			lines.push(`    - Bookmark removed: ${displayString(bookmark)}`);
		}

		const unnamed = presets.count - presets.bookmarks.length;

		if (unnamed > 0) {
			lines.push(`    - ${unnamed} unnamed ${unnamed === 1 ? 'preset' : 'presets'} removed`);
		}
	}

	const users = impact.find(
		(entry): entry is Extract<RoleDeletionImpactEntry, { kind: 'users' }> => entry.kind === 'users'
	);

	if (users) {
		for (const id of users.suspended) {
			lines.push(`    - User suspended: ${replaceControlCharacters(id)}`);
		}
	}

	const sessions = impact.find(
		(entry): entry is Extract<RoleDeletionImpactEntry, { kind: 'sessions' }> => entry.kind === 'sessions'
	);

	if (sessions && sessions.active > 0) {
		lines.push(`    - ${sessions.active} active ${sessions.active === 1 ? 'session' : 'sessions'} affected`);
	}

	return lines;
}
