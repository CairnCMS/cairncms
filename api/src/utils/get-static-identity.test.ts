import type { Knex } from 'knex';
import { describe, expect, it, vi } from 'vitest';
import { getStaticIdentityById } from './get-static-identity.js';

function knexReturning(row: unknown): { db: Knex; where: ReturnType<typeof vi.fn> } {
	const where = vi.fn().mockReturnThis();

	const db = {
		select: vi.fn().mockReturnThis(),
		from: vi.fn().mockReturnThis(),
		leftJoin: vi.fn().mockReturnThis(),
		where,
		first: vi.fn().mockResolvedValue(row),
	} as unknown as Knex;

	return { db, where };
}

describe('getStaticIdentityById', () => {
	const userID = '3fac3c02-607f-4438-8d6e-6b8b25109b52';

	it('looks up the pinned user by id and maps its fields and boolean flags', async () => {
		const { db, where } = knexReturning({
			status: 'active',
			token: 'static-token',
			role: 'role-1',
			admin_access: 1,
			app_access: 0,
		});

		await expect(getStaticIdentityById(userID, { database: db })).resolves.toEqual({
			status: 'active',
			token: 'static-token',
			role: 'role-1',
			admin: true,
			app: false,
		});

		expect(where).toHaveBeenCalledWith({ 'directus_users.id': userID });
	});

	it('returns null for a missing user', async () => {
		const { db } = knexReturning(undefined);
		await expect(getStaticIdentityById(userID, { database: db })).resolves.toBeNull();
	});
});
