import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

export class RemoteTokenError extends Error {
	readonly exitCode = 2;
}

export type RemoteTokenInputs = {
	envToken: string | undefined;
	tokenFile: string | undefined;
	tokenStdin: boolean;
	readStdin: () => string;
};

export function resolveRemoteToken(inputs: RemoteTokenInputs): string {
	const provided = [inputs.envToken !== undefined, inputs.tokenFile !== undefined, inputs.tokenStdin].filter(
		Boolean
	).length;

	if (provided === 0) {
		throw new RemoteTokenError(
			'A remote apply needs a token. Provide exactly one of CAIRNCMS_TOKEN, CAIRNCMS_TOKEN_FILE, or --token-stdin.'
		);
	}

	if (provided > 1) {
		throw new RemoteTokenError(
			'Provide the token through exactly one of CAIRNCMS_TOKEN, CAIRNCMS_TOKEN_FILE, or --token-stdin.'
		);
	}

	if (inputs.envToken !== undefined) return parseToken(inputs.envToken);
	if (inputs.tokenFile !== undefined) return parseToken(readTokenFile(inputs.tokenFile));

	return parseToken(inputs.readStdin());
}

function parseToken(raw: string): string {
	let token = raw;

	if (token.endsWith('\r\n')) token = token.slice(0, -2);
	else if (token.endsWith('\n')) token = token.slice(0, -1);

	if (token.length === 0) throw new RemoteTokenError('The provided token is empty.');
	if (/[\r\n]/.test(token)) throw new RemoteTokenError('The provided token contains a line break.');

	return token;
}

function readTokenFile(path: string): string {
	let fd: number;

	try {
		fd = openSync(path, 'r');
	} catch {
		throw new RemoteTokenError('The token file could not be opened.');
	}

	try {
		const stat = fstatSync(fd);

		if (!stat.isFile()) {
			throw new RemoteTokenError('The token file is not a regular file.');
		}

		if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
			throw new RemoteTokenError('The token file is accessible to group or others. Restrict it to owner-only (0600).');
		}

		return readFileSync(fd, 'utf8');
	} finally {
		closeSync(fd);
	}
}
