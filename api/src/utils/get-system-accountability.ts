import type { Accountability } from '@cairncms/types';

export function getSystemAccountability(): Accountability {
	return {
		user: null,
		role: null,
		admin: true,
		app: true,
		permissions: [],
	};
}
