export const CORS_DENY_WITH_VARY = Symbol('cors-deny-with-vary');

export type MiddlewareOrigin = false | true | string | typeof CORS_DENY_WITH_VARY;

export type CorsOriginResolution = {
	allowed: boolean;
	middlewareOrigin: MiddlewareOrigin;
};

function testRegex(pattern: RegExp, value: string | undefined): boolean {
	if (value === undefined) return false;

	const lastIndex = pattern.lastIndex;
	pattern.lastIndex = 0;

	try {
		return pattern.test(value);
	} finally {
		pattern.lastIndex = lastIndex;
	}
}

function matchesEntry(entry: unknown, value: string | undefined): boolean {
	if (typeof entry === 'string') return entry === value;
	if (entry instanceof RegExp) return testRegex(entry, value);
	return Boolean(entry);
}

export function resolveCorsOrigin(requestOrigin: string | undefined, config: unknown): CorsOriginResolution {
	if (config === true) return { allowed: true, middlewareOrigin: true };
	if (config === '*') return { allowed: true, middlewareOrigin: '*' };

	if (typeof config === 'string') {
		return { allowed: config === requestOrigin, middlewareOrigin: config };
	}

	if (config instanceof RegExp) {
		return testRegex(config, requestOrigin)
			? { allowed: true, middlewareOrigin: true }
			: { allowed: false, middlewareOrigin: CORS_DENY_WITH_VARY };
	}

	if (Array.isArray(config)) {
		return config.some((entry) => matchesEntry(entry, requestOrigin))
			? { allowed: true, middlewareOrigin: true }
			: { allowed: false, middlewareOrigin: CORS_DENY_WITH_VARY };
	}

	return { allowed: false, middlewareOrigin: false };
}
