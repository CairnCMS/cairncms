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

export function getSafeRedirect(redirect: unknown): string | null {
	if (!isSafeRedirect(redirect)) return null;

	const base = new URL(env['PUBLIC_URL'] as string);
	const target = new URL(String(redirect), base);

	return `${target.pathname}${target.search}${target.hash}`;
}

export function getSafeRedirectWithReason(redirect: unknown, reason: string): string | null {
	if (!isSafeRedirect(redirect)) return null;

	const base = new URL(env['PUBLIC_URL'] as string);
	const target = new URL(String(redirect), base);

	target.hash = '';
	target.search = '';
	target.searchParams.set('reason', reason);

	return `${target.pathname}${target.search}`;
}
