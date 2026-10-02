export * from './identities';
export * from './schema';
export * from './seed-functions';
export { CreateItem, requestGraphQL } from './request';
import type { Query } from '@cairncms/types';
import { omit } from 'lodash';
import type { Api } from './environment';
import { setupRequest as request } from './request';

export async function ReadItem(api: Api, options: { collection: string } & Query) {
	const response = await request(api.url)
		.get('/items/' + options.collection)
		.auth(api.adminToken, { type: 'bearer' })
		.query(omit({ filter: {}, fields: '*', ...options }, 'collection'))
		.expect(200);

	return response.body.data;
}
