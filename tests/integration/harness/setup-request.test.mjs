import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createRequest, assertSetupResponse } from '../fixtures/request-agent.mjs';

async function responseServer(status, body, action, headers = {}) {
	const server = createServer((request, response) => {
		request.resume();
		response.writeHead(status, { 'content-type': 'application/json', ...headers });
		response.end(JSON.stringify(body));
	});

	server.listen(0, '127.0.0.1');
	await once(server, 'listening');

	try {
		await action(`http://127.0.0.1:${server.address().port}`);
	} finally {
		server.closeAllConnections();
		await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}
}

for (const endpoint of ['roles', 'users', 'collections', 'fields/example', 'relations', 'items/example']) {
	for (const [status, body] of [
		[400, { errors: [{ message: 'Fixture rejection detail', extensions: { code: 'INVALID_PAYLOAD' } }] }],
		[500, { errors: [{ message: 'Database setup failed' }] }],
		[200, {}],
		[200, { data: null }],
	])
		test(`${endpoint} setup rejects HTTP ${status} with ${JSON.stringify(body)}`, async () => {
			await responseServer(status, body, async (url) => {
				await assert.rejects(
					createRequest(url, { setup: true })
						.post(`/${endpoint}`)
						.send({ collection: 'example', field: 'parent' })
						.expect(200),
					(error) => {
						assert.match(error.message, /HTTP request failed/);
						assert(error.message.includes(`"status":${status}`));
						if (body.errors) assert(error.message.includes(body.errors[0].message));
						assert.equal(error.response, undefined);
						return true;
					}
				);
			});
		});
}

test('relation setup rejects absent or mismatched field identities', async () => {
	for (const data of [{}, { collection: 'example' }, { collection: 'example', field: 'other' }])
		await responseServer(200, { data }, async (url) => {
			await assert.rejects(
				createRequest(url, { setup: true })
					.post('/relations')
					.send({ collection: 'example', field: 'parent' })
					.expect(200),
				/identity|malformed data/
			);
		});
});

test('valid setup, explicit expected rejection and ordinary product error inspection remain supported', async () => {
	await responseServer(
		200,
		{ data: { collection: 'example', field: 'parent', related_collection: null } },
		async (url) => {
			const response = await createRequest(url, { setup: true })
				.post('/relations')
				.send({ collection: 'example', field: 'parent' })
				.expect(200);

			assert.equal(response.body.data.field, 'parent');
		}
	);

	await responseServer(400, { errors: [{ extensions: { code: 'INVALID_PAYLOAD' } }] }, async (url) => {
		await createRequest(url, { setup: true }).post('/fields/example').expect(400);
		const response = await createRequest(url).post('/fields/example');
		assert.equal(response.status, 400);
	});
});

test('GraphQL setup rejects errors even when HTTP succeeds', async () => {
	await responseServer(200, { errors: [{ message: 'Mutation rejected' }], data: null }, async (url) => {
		await assert.rejects(createRequest(url, { setup: true }).post('/graphql').expect(200), /Mutation rejected/);
	});
});

test('deferred setup validation preserves HTTP context and rejects unexpected deletion errors', async () => {
	await responseServer(
		500,
		{ errors: [{ message: 'Deletion failed', extensions: { code: 'DATABASE_ERROR' } }] },
		async (url) => {
			const response = await createRequest(url).delete('/collections/example');
			assert.throws(() => assertSetupResponse(response), /Deletion failed.*DATABASE_ERROR/);
		}
	);
});

test('setup diagnostics retain fictional fixture values and API error details', async () => {
	const body = {
		errors: [
			{ message: 'Duplicate fictional-token', extensions: { code: 'INVALID_PAYLOAD', token: 'fictional-token' } },
		],
	};

	await responseServer(400, body, async (url) => {
		await assert.rejects(
			createRequest(url, { setup: true }).post('/users').send({ token: 'fictional-token' }),
			(error) => {
				assert.match(error.message, /Duplicate fictional-token/);
				assert.match(error.message, /"token":"fictional-token"/);
				assert.match(error.message, /INVALID_PAYLOAD/);
				return true;
			}
		);
	});
});
