import type { Accountability } from '@cairncms/types';

export type RequestContext = {
	ip: string;
	userAgent?: string | null | undefined;
	origin?: string | null | undefined;
};

export type RequestAccountability = Accountability & {
	ip: string;
	user: string | null;
	admin: boolean;
	app: boolean;
};

export function getAnonymousAccountability(context: RequestContext): RequestAccountability {
	const accountability: RequestAccountability = {
		user: null,
		role: null,
		admin: false,
		app: false,
		ip: context.ip,
	};

	if (context.userAgent) accountability.userAgent = context.userAgent;
	if (context.origin) accountability.origin = context.origin;

	return accountability;
}
