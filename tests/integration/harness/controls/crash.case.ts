import { apiTest as test } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('child exit rejects an outstanding HTTP request', async ({ api }) => {
	const pending = request(api.url)
		.post('/auth/login')
		.send({ email: 'nobody@example.com', password: 'wrong' })
		.then((r) => r);

	setTimeout(() => api.child.kill('SIGKILL'), 50);
	await pending;
});
