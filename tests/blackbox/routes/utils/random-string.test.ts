import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { requestGraphQL } from '@common/transport';

const adminToken = common.USER.ADMIN.TOKEN;

describe('/utils/random/string', () => {
	describe('GraphQL', () => {
		describe.each([0, -1])('rejects length %s', (length) => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await requestGraphQL(getUrl(vendor), true, adminToken, {
					mutation: { utils_random_string: { __args: { length } } },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.errors[0].extensions.code).toBe('INVALID_PAYLOAD');
				expect(response.body.data).toEqual({ utils_random_string: null });
			});
		});

		describe('defaults to a 32 character string when length is omitted', () => {
			it.each(vendors)('%s', async (vendor) => {
				const response = await requestGraphQL(getUrl(vendor), true, adminToken, {
					mutation: { utils_random_string: true },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.data.utils_random_string).toHaveLength(32);
			});
		});
	});
});
