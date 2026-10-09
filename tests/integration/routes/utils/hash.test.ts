import { describe, expect } from 'vitest';
import type { Api } from '../../fixtures/environment';
import { identityTest as test, USER } from '../../fixtures/identities';
import request, { requestGraphQL, setupRequest } from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const STRING = 'correct-string';

async function generateAdminHash(api: Api): Promise<string> {
	const response = await setupRequest(api.url)
		.post('/utils/hash/generate')
		.auth(api.adminToken, { type: 'bearer' })
		.send({ string: STRING })
		.expect(200);

	return response.body.data;
}

const DENIED_CALLERS: [string, string | null][] = [
	['Unauthenticated', null],
	[USER.APP_ACCESS!.NAME, USER.APP_ACCESS!.TOKEN],
];

describe('/utils/hash', () => {
	describe('REST', () => {
		describe.each(DENIED_CALLERS)('%s', (_name, token) => {
			test('is forbidden from generating a hash', async ({ api }) => {
				const pending = request(api.url).post('/utils/hash/generate').send({ string: STRING });
				if (token) pending.set('Authorization', `Bearer ${token}`);
				const response = await pending;

				expect(response.statusCode).toBe(403);
				expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
			});

			test('is forbidden from verifying a hash', async ({ api }) => {
				const hash = await generateAdminHash(api);

				const pending = request(api.url).post('/utils/hash/verify').send({ string: STRING, hash });
				if (token) pending.set('Authorization', `Bearer ${token}`);
				const response = await pending;

				expect(response.statusCode).toBe(403);
				expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
			});
		});

		describe(USER.ADMIN!.NAME, () => {
			test('generates and verifies a hash', async ({ api }) => {
				const generated = await request(api.url)
					.post('/utils/hash/generate')
					.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`)
					.send({ string: STRING });

				expect(generated.statusCode).toBe(200);
				expect(generated.body.data).toMatch(/^\$argon2/);

				const match = await request(api.url)
					.post('/utils/hash/verify')
					.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`)
					.send({ string: STRING, hash: generated.body.data });

				const mismatch = await request(api.url)
					.post('/utils/hash/verify')
					.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`)
					.send({ string: 'wrong-string', hash: generated.body.data });

				expect(match.statusCode).toBe(200);
				expect(match.body.data).toBe(true);
				expect(mismatch.statusCode).toBe(200);
				expect(mismatch.body.data).toBe(false);
			});
		});
	});

	describe('GraphQL', () => {
		describe.each(DENIED_CALLERS)('%s', (_name, token) => {
			test('is forbidden from generating a hash', async ({ api }) => {
				const response = await requestGraphQL(api.url, true, token, {
					mutation: { utils_hash_generate: { __args: { string: STRING } } },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
				expect(response.body.data).toEqual({ utils_hash_generate: null });
			});

			test('is forbidden from verifying a hash', async ({ api }) => {
				const hash = await generateAdminHash(api);

				const response = await requestGraphQL(api.url, true, token, {
					mutation: { utils_hash_verify: { __args: { string: STRING, hash } } },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
				expect(response.body.data).toEqual({ utils_hash_verify: null });
			});

			test('is forbidden from verifying a malformed hash before it is parsed', async ({ api }) => {
				const response = await requestGraphQL(api.url, true, token, {
					mutation: { utils_hash_verify: { __args: { string: STRING, hash: 'not-an-argon2-hash' } } },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.errors?.[0]?.extensions?.code).toBe('FORBIDDEN');
			});
		});

		describe(USER.ADMIN!.NAME, () => {
			test('generates and verifies a hash', async ({ api }) => {
				const generated = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
					mutation: { utils_hash_generate: { __args: { string: STRING } } },
				});

				expect(generated.statusCode).toBe(200);
				expect(generated.body.data.utils_hash_generate).toMatch(/^\$argon2/);

				const hash = generated.body.data.utils_hash_generate;

				const match = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
					mutation: { utils_hash_verify: { __args: { string: STRING, hash } } },
				});

				const mismatch = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
					mutation: { utils_hash_verify: { __args: { string: 'wrong-string', hash } } },
				});

				expect(match.body.data).toEqual({ utils_hash_verify: true });
				expect(mismatch.body.data).toEqual({ utils_hash_verify: false });
			});

			test('returns an invalid-payload error for a malformed hash', async ({ api }) => {
				const response = await requestGraphQL(api.url, true, USER.ADMIN!.TOKEN, {
					mutation: { utils_hash_verify: { __args: { string: STRING, hash: 'not-an-argon2-hash' } } },
				});

				expect(response.statusCode).toBe(200);
				expect(response.body.errors?.[0]?.extensions?.code).toBe('INVALID_PAYLOAD');
				expect(response.body.data).toEqual({ utils_hash_verify: null });
			});

			test('marks both mutations as deprecated', async ({ api }) => {
				const response = await request(api.url)
					.post('/graphql/system')
					.set('Authorization', `Bearer ${USER.ADMIN!.TOKEN}`)
					.send({
						query:
							'{ __type(name: "Mutation") { fields(includeDeprecated: true) { name isDeprecated deprecationReason } } }',
					});

				expect(response.statusCode).toBe(200);

				const fields: { name: string; isDeprecated: boolean; deprecationReason: string | null }[] =
					response.body.data.__type.fields;

				for (const name of ['utils_hash_generate', 'utils_hash_verify']) {
					const field = fields.find((candidate) => candidate.name === name);

					expect(field?.isDeprecated).toBe(true);
					expect(field?.deprecationReason).toEqual(expect.stringMatching(/\S/));
				}
			});
		});
	});
});
