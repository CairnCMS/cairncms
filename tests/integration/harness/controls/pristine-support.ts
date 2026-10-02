import assert from 'node:assert/strict';
import { expect } from 'vitest';
import { snapshotHash, snapshotInventory } from '../snapshot.mjs';
import type { ProvidedContext } from 'vitest';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { withEnvironment } from '../../fixtures/environment';

export async function ensureTemplate(runtime: ProvidedContext['integration'], signal: AbortSignal) {
	try {
		await access(join(runtime.pristine!.directory, 'ready.json'));
	} catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;

		await withEnvironment(
			runtime,
			false,
			async (api) => {
				if (!api.adminToken) throw new Error('Bootstrap login missing');
			},
			signal
		);
	}
}

export function canonicalFresh(input: Awaited<ReturnType<typeof snapshotInventory>>) {
	const value = structuredClone(input);
	const users = value.rows.directus_users;
	const roles = value.rows.directus_roles;
	expect(users.length).toBe(1);
	expect(roles.length).toBe(2);
	const admin = roles.find((role: Record<string, unknown>) => role.id === users[0].role);
	assert(admin);
	expect([true, 1]).toContain(admin.admin_access);

	expect(
		roles.some(
			(role: Record<string, unknown>) => role.id === '00000000-0000-0000-0000-000000000000' && role.key === 'public'
		)
	).toBe(true);

	const replacements = new Map([
		[users[0].id, '<bootstrap-user>'],
		[admin.id, '<bootstrap-role>'],
		[users[0].password, '<verified-password>'],
	]);

	for (const table of ['directus_activity', 'directus_migrations'])
		for (const row of value.rows[table]) row.timestamp = '<timestamp>';

	for (const row of value.rows.directus_revisions)
		for (const key of ['data', 'delta']) {
			const text = row[key];
			if (typeof text === 'string') row[key] = JSON.parse(text);
		}

	// Both inventories are read after the fixture's real administrator login.
	users[0].last_access = '<login-time>';
	expect(value.rows.directus_sessions.length).toBe(1);

	for (const row of value.rows.directus_sessions) {
		expect(row.token).toBeTypeOf('string');
		assert(typeof row.expires === 'string' || typeof row.expires === 'number');
		expect(new Date(row.expires).getTime()).toBeGreaterThan(0);
		row.token = '<session-token>';
		row.expires = '<session-expiry>';
	}

	const visit = (entry: unknown): unknown => {
		if (typeof entry === 'string') return replacements.get(entry) ?? entry;
		if (Array.isArray(entry)) return entry.map(visit);
		if (entry && typeof entry === 'object')
			return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, visit(value)]));
		return entry;
	};

	const result = visit(value) as typeof value;
	for (const rows of Object.values(result.rows) as Record<string, unknown>[][])
		rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
	return snapshotHash(result);
}
