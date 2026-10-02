declare const OperatorRemoteTargetBrand: unique symbol;

/**
 * A remote target the operator supplied explicitly through --url. It is the only value the remote transport
 * accepts, so a target can never be sourced from a manifest, an API response, or a redirect. Construct it only
 * through parseOperatorRemoteTarget.
 */
export type OperatorRemoteTarget = {
	readonly base: URL;
	readonly [OperatorRemoteTargetBrand]: true;
};

export class RemoteTargetError extends Error {
	readonly exitCode = 2;
}

export function parseOperatorRemoteTarget(input: string): OperatorRemoteTarget {
	let url: URL;

	try {
		url = new URL(input);
	} catch {
		throw new RemoteTargetError('The --url value must be a complete absolute http:// or https:// URL.');
	}

	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new RemoteTargetError('The --url must use the http:// or https:// scheme.');
	}

	if (url.username !== '' || url.password !== '') {
		throw new RemoteTargetError('The --url must not contain credentials.');
	}

	if (url.search !== '') {
		throw new RemoteTargetError('The --url must not contain a query string.');
	}

	if (url.hash !== '') {
		throw new RemoteTargetError('The --url must not contain a fragment.');
	}

	const base = new URL(url.href);
	if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;

	return { base } as OperatorRemoteTarget;
}

export function resolveEndpoint(target: OperatorRemoteTarget, endpoint: string): URL {
	return new URL(endpoint, target.base);
}

export function isHttpTarget(target: OperatorRemoteTarget): boolean {
	return target.base.protocol === 'http:';
}
