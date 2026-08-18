import type { ShareScope } from '@cairncms/types';
import type { Knex } from 'knex';
import { getEnv } from '../env.js';
import { InvalidCredentialsException } from '../exceptions/index.js';
import isCairnJWT from './is-cairncms-jwt.js';
import { verifyAccessJWT } from './jwt.js';

export type TokenIdentity = {
	role: string | null;
	admin: boolean;
	app: boolean;
	user?: string;
	share?: string;
	share_scope?: ShareScope;
};

export async function getTokenIdentity(token: string, deps: { database: Knex }): Promise<TokenIdentity> {
	if (isCairnJWT(token)) {
		const payload = verifyAccessJWT(token, getEnv()['SECRET']);

		const identity: TokenIdentity = {
			role: payload.role,
			admin: payload.admin_access === true || payload.admin_access == 1,
			app: payload.app_access === true || payload.app_access == 1,
		};

		if (payload.share) identity.share = payload.share;
		if (payload.share_scope) identity.share_scope = payload.share_scope;
		if (payload.id) identity.user = payload.id;

		return identity;
	}

	const user = await deps.database
		.select('directus_users.id', 'directus_users.role', 'directus_roles.admin_access', 'directus_roles.app_access')
		.from('directus_users')
		.leftJoin('directus_roles', 'directus_users.role', 'directus_roles.id')
		.where({
			'directus_users.token': token,
			status: 'active',
		})
		.first();

	if (!user) {
		throw new InvalidCredentialsException();
	}

	return {
		user: user.id,
		role: user.role,
		admin: user.admin_access === true || user.admin_access == 1,
		app: user.app_access === true || user.app_access == 1,
	};
}
