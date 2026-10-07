import { inject } from 'vitest';
import { Wait } from 'testcontainers';
import { createEnvironmentTest, apiFixtures, type EnvironmentOptions } from '../../fixtures/environment';
import { capturePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
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

// Native cancellation can abandon a test body's pending work. Fixture setup must own startup.
const test = createEnvironmentTest()
	.extend<{ configurationState: Prerequisite<EnvironmentOptions> }>({
		configurationState: [
			async ({ cancellationSignal, teardownFailures }, use) => {
				const name = process.env.CONTROL_STARTUP_SERVICE as keyof typeof definitions;
				if (!definitions[name]) throw new Error('Missing startup control service');

				await capturePrerequisite<EnvironmentOptions>(
					(ready) =>
						withService(
							{
								...definitions[name],
								wait: Wait.forLogMessage('CAIRN_CONTROL_THIS_READINESS_MARKER_IS_NEVER_EMITTED'),
								startupTimeoutMs: 2_000,
							},
							inject('integration').directory,
							cancellationSignal,
							() => ready({})
						),
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
	})
	.extend(apiFixtures);

test('unready service fails before any API is provisioned', async ({ api }) => {
	void api;
	throw new Error('UNEXPECTED_SERVICE_READY');
}, 20_000);
