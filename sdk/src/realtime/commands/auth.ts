export interface TokenAuth {
	access_token: string;
	uid?: string;
}

export function auth(creds: TokenAuth) {
	return JSON.stringify({ ...creds, type: 'auth' });
}
