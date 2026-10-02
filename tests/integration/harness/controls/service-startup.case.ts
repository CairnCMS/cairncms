import { inject } from 'vitest';
import { Wait } from 'testcontainers';
import { createEnvironmentTest } from '../../fixtures/environment';
import { withService } from '../../fixtures/service';
import { redisImages } from '../../fixtures/redis';
import { s3Image } from '../../fixtures/storage';
import { samlImage } from '../../fixtures/saml';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

const definitions = {
	redis: { name: 'redis-startup-control', image: redisImages.redis6, port: 6379 },
	saml: { name: 'saml-startup-control', image: samlImage, port: 8080 },
	storage: { name: 'storage-startup-control', image: s3Image, port: 80 },
};

const test = createEnvironmentTest();

test('unready service fails before any API is provisioned', async ({ cancellationSignal }) => {
	const name = process.env.CONTROL_STARTUP_SERVICE as keyof typeof definitions;
	if (!definitions[name]) throw new Error('Missing startup control service');

	await withService(
		{
			...definitions[name],
			wait: Wait.forLogMessage('CAIRN_CONTROL_THIS_READINESS_MARKER_IS_NEVER_EMITTED'),
			startupTimeoutMs: 2_000,
		},
		inject('integration').directory,
		cancellationSignal,
		async () => {
			throw new Error('UNEXPECTED_SERVICE_READY');
		}
	);
}, 20_000);
