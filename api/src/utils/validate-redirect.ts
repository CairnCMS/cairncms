import env from '../env.js';

export function isSafeRedirect(redirect: unknown): boolean {
	if (typeof redirect !== 'string' || redirect.length === 0) {
		return false;
	}

	try {
		const base = new URL(env['PUBLIC_URL'] as string);
		const target = new URL(redirect, base);
		return target.origin === base.origin;
	} catch {
		return false;
	}
}
