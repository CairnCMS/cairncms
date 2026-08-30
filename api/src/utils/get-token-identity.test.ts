import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InvalidCredentialsException } from '../exceptions/invalid-credentials.js';
import { getTokenIdentity } from './get-token-identity.js';

vi.mock('../env', () => {
	const MOCK_ENV = { SECRET: 'test' };

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

function knexReturning(user: unknown): { db: Knex; where: ReturnType<typeof vi.fn> } {
	const where = vi.fn().mockReturnThis();

	const db = {
		select: vi.fn().mockReturnThis(),
		from: vi.fn().mockReturnThis(),
		leftJoin: vi.fn().mockReturnThis(),
		where,
		first: vi.fn().mockResolvedValue(user),
	} as unknown as Knex;

	return { db, where };
}

function signed(payload: Record<string, unknown>): string {
	return jwt.sign(payload, 'test', { issuer: 'cairncms' });
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('getTokenIdentity', () => {
	const userID = '3fac3c02-607f-4438-8d6e-6b8b25109b52';
	const roleID = '38269fc6-6eb6-475a-93cb-479d97f73039';
	const share = 'ca0ad005-f4ad-4bfe-b428-419ee8784790';
	const shareScope = { collection: 'articles', item: 15 };

	describe('CairnCMS JWT', () => {
		it('applies boolean access flags and carries share claims', async () => {
			const token = signed({
				id: userID,
				role: roleID,
				app_access: true,
				admin_access: false,
				share,
				share_scope: shareScope,
			});

			const { db } = knexReturning(undefined);

			await expect(getTokenIdentity(token, { database: db })).resolves.toEqual({
				user: userID,
				role: roleID,
				admin: false,
				app: true,
				share,
				share_scope: shareScope,
			});
		});

		it('applies numeric access flags', async () => {
			const token = signed({ id: userID, role: roleID, app_access: 1, admin_access: 0 });
			const { db } = knexReturning(undefined);
			const identity = await getTokenIdentity(token, { database: db });
			expect(identity.app).toBe(true);
			expect(identity.admin).toBe(false);
		});

		it('applies string access flags', async () => {
			const token = signed({ id: userID, role: roleID, app_access: '1', admin_access: '0' });
			const { db } = knexReturning(undefined);
			const identity = await getTokenIdentity(token, { database: db });
			expect(identity.app).toBe(true);
			expect(identity.admin).toBe(false);
		});

		it('omits share, share_scope, and user when the payload lacks them', async () => {
			const token = signed({ role: roleID, app_access: false, admin_access: false });
			const { db } = knexReturning(undefined);
			const identity = await getTokenIdentity(token, { database: db });

			expect(identity).toEqual({ role: roleID, admin: false, app: false });
			expect('user' in identity).toBe(false);
			expect('share' in identity).toBe(false);
			expect('share_scope' in identity).toBe(false);
		});
	});

	describe('static token', () => {
		it('resolves an active user, applying boolean, numeric, and string flags', async () => {
			const cases: Array<{ admin_access: unknown; app_access: unknown; admin: boolean; app: boolean }> = [
				{ admin_access: true, app_access: false, admin: true, app: false },
				{ admin_access: 1, app_access: 0, admin: true, app: false },
				{ admin_access: '0', app_access: '1', admin: false, app: true },
			];

			for (const { admin_access, app_access, admin, app } of cases) {
				const { db } = knexReturning({ id: 'test-id', role: 'test-role', admin_access, app_access });

				await expect(getTokenIdentity('static-token', { database: db })).resolves.toEqual({
					user: 'test-id',
					role: 'test-role',
					admin,
					app,
				});
			}
		});

		it('queries only active users and throws when none match', async () => {
			const { db, where } = knexReturning(undefined);

			await expect(getTokenIdentity('static-token', { database: db })).rejects.toEqual(
				new InvalidCredentialsException()
			);

			expect(where).toHaveBeenCalledWith({ 'directus_users.token': 'static-token', status: 'active' });
		});
	});

	it('returns only the claims of the resolved token across repeated calls', async () => {
		const withShare = signed({
			id: 'u1',
			role: 'r1',
			app_access: false,
			admin_access: false,
			share: 's1',
			share_scope: { collection: 'c', item: 1 },
		});

		const withoutShare = signed({ id: 'u2', role: 'r2', app_access: false, admin_access: false });
		const { db } = knexReturning(undefined);

		const first = await getTokenIdentity(withShare, { database: db });
		expect(first.share).toBe('s1');

		const second = await getTokenIdentity(withoutShare, { database: db });
		expect('share' in second).toBe(false);
		expect('share_scope' in second).toBe(false);
		expect(second.user).toBe('u2');
	});
});
