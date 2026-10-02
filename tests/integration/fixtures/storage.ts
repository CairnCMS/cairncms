import { inject } from 'vitest';
import { S3Client, CreateBucketCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { withService } from './service';
import { createEnvironmentTest, apiFixtures, type EnvironmentOptions } from './environment';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from './prerequisite';

export const s3Image = 'andrewgaul/s3proxy@sha256:87662b2a5afcdfa5f478a1c61650bae4c87bbd15f6ff2823236bcfd66ef7fe04';
export type StorageService = {
	client: S3Client;
	bucket: string;
	env: Record<string, string>;
	available: () => boolean;
};

export async function withStorage(
	directory: string,
	signal: AbortSignal,
	use: (storage: StorageService) => Promise<void>
) {
	await withService(
		{
			name: 's3proxy',
			image: s3Image,
			port: 80,
			environment: {
				S3PROXY_AUTHORIZATION: 'aws-v4',
				S3PROXY_IDENTITY: 'cairncms',
				S3PROXY_CREDENTIAL: 'miniosecret',
				JCLOUDS_PROVIDER: 'filesystem',
				JCLOUDS_FILESYSTEM_BASEDIR: '/data',
				LANG: 'C.UTF-8',
				LC_ALL: 'C.UTF-8',
			},
		},
		directory,
		signal,
		async (service) => {
			const endpoint = `http://${service.host}:${service.port}`;
			const bucket = `integration-${randomUUID()}`;

			const client = new S3Client({
				endpoint,
				region: 'us-east-1',
				forcePathStyle: true,
				maxAttempts: 1,
				credentials: { accessKeyId: 'cairncms', secretAccessKey: 'miniosecret' },
			});

			try {
				await client.send(new CreateBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10_000) });
				await client.send(new HeadBucketCommand({ Bucket: bucket }), { abortSignal: AbortSignal.timeout(10_000) });

				await use({
					client,
					bucket,
					available: service.available,
					env: {
						STORAGE_LOCATIONS: 'local,s3',
						STORAGE_S3_DRIVER: 's3',
						STORAGE_S3_KEY: 'cairncms',
						STORAGE_S3_SECRET: 'miniosecret',
						STORAGE_S3_BUCKET: bucket,
						STORAGE_S3_REGION: 'us-east-1',
						STORAGE_S3_ENDPOINT: endpoint,
						STORAGE_S3_FORCE_PATH_STYLE: 'true',
					},
				});
			} finally {
				client.destroy();
			}
		}
	);
}

export function createStorageTest(options: EnvironmentOptions = {}) {
	return createEnvironmentTest()
		.extend<{
			storageState: Prerequisite<StorageService>;
			storage: StorageService;
			configurationState: Prerequisite<EnvironmentOptions>;
		}>({
			storageState: [
				async ({ cancellationSignal, teardownFailures }, use) => {
					await capturePrerequisite(
						(ready) => withStorage(inject('integration').directory, cancellationSignal, ready),
						use,
						teardownFailures
					);
				},
				{ scope: 'file' },
			],
			configurationState: [
				async ({ storageState }, use) => {
					if (!storageState.ok) return use(storageState);
					await use({ ok: true, value: { ...options, env: { ...options.env, ...storageState.value.env } } });
				},
				{ scope: 'file' },
			],
			storage: async ({ storageState, task, skip }, use) => {
				const storage = requirePrerequisite(storageState, 'S3 storage', { task, skip });
				if (!storage.available()) throw new Error('Owned S3 storage stopped');
				await use(storage);
			},
		})
		.extend(apiFixtures);
}
