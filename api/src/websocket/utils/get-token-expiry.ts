import jwt from 'jsonwebtoken';

export function getTokenExpiry(token: string): number | null {
	const payload = jwt.decode(token, { json: true });

	if (payload && typeof payload.exp === 'number') {
		return payload.exp;
	}

	return null;
}
