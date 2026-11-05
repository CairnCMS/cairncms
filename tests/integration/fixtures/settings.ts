import { expect } from 'vitest';
import type { Api } from './environment';
import request, { setupRequest } from './request';

/** Applies project settings for the length of a case, then restores the previous values of the same fields. */
export async function withSettings(api: Api, settings: Record<string, unknown>, run: () => Promise<void>) {
	const auth = `Bearer ${api.adminToken}`;
	const fields = Object.keys(settings);

	const before = await setupRequest(api.url)
		.get('/settings')
		.query({ fields: fields.join(',') })
		.set('Authorization', auth);

	const original = Object.fromEntries(fields.map((field) => [field, before.body.data[field] ?? null]));
	let restoreStatus: number | undefined;

	try {
		await setupRequest(api.url).patch('/settings').set('Authorization', auth).send(settings);
		await run();
	} finally {
		restoreStatus = (await request(api.url).patch('/settings').set('Authorization', auth).send(original)).statusCode;
	}

	expect(restoreStatus).toBe(200);
}
