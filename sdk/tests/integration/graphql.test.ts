import { describe, expect, it } from 'vitest';
import { authentication, createCairnCMS, graphql } from '../../src/index.js';
import { COLLECTIONS, ENV_KEYS, ITEM_IDS } from './helpers/constants.js';

const URL = process.env[ENV_KEYS.url]!;
const EMAIL = process.env[ENV_KEYS.adminEmail]!;
const PASSWORD = process.env[ENV_KEYS.adminPassword]!;

describe('GraphQL', () => {
	it('executes an authenticated query against /graphql', async () => {
		const client = createCairnCMS(URL).with(authentication('json')).with(graphql());
		await client.login(EMAIL, PASSWORD);

		const result: any = await client.query<{ [k: string]: Array<{ id: string; name: string; value: number }> }>(
			`query { ${COLLECTIONS.items}(filter: { id: { _eq: "${ITEM_IDS.laptop}" } }) { id name value } }`
		);

		const items = result[COLLECTIONS.items];
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ id: ITEM_IDS.laptop, name: 'laptop', value: 1200 });
	});
});
