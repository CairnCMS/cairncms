import { setupRequest } from '../../fixtures/request';
import type { Api } from '../../fixtures/environment';
import { createIdentityTest, USER } from '../../fixtures/identities';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateCollection, CreateField } from '../../fixtures/schema';
import request from '../../fixtures/request';

const collectionName = 'schema_timezone_tests';
type SchemaTimezoneTypesObject = {
	date: string;
	time?: string;
	datetime: string;
	timestamp: string;
};

export const sampleDates: SchemaTimezoneTypesObject[] = [];

for (let i = 0; i < 24; i++) {
	const hour = i < 10 ? '0' + i : String(i);

	sampleDates.push(
		{
			date: `2022-01-05`,
			time: `${hour}:11:11`,
			datetime: `2022-01-05T${hour}:11:11`,
			timestamp: `2022-01-05T${hour}:11:11-01:00`,
		},
		{
			date: `2022-01-10`,
			time: `${hour}:22:22`,
			datetime: `2022-01-10T${hour}:22:22`,
			timestamp: `2022-01-10T${hour}:22:22Z`,
		},
		{
			date: `2022-01-15`,
			time: `${hour}:33:33`,
			datetime: `2022-01-15T${hour}:33:33`,
			timestamp: `2022-01-15T${hour}:33:33+02:00`,
		}
	);
}

export async function DeleteCollection(api: Api, options: { collection: string }) {
	return (
		await request(api.url)
			.delete('/collections/' + options.collection)
			.auth(api.adminToken, { type: 'bearer' })
	).body;
}
export async function prepareTimezoneSchema(api: Api, vendor: string) {
	// Delete the table in case it already exists
	await DeleteCollection(api, { collection: collectionName });

	const tableOptions = {
		collection: collectionName,
		schema: {},
		meta: {},
	};

	await CreateCollection(api, tableOptions);

	const fieldOptions = {
		collection: collectionName,
		field: 'date',
		meta: {},
		schema: {},
		type: 'date',
	};

	await CreateField(api, fieldOptions);

	fieldOptions.field = 'time';
	fieldOptions.type = 'time';
	await CreateField(api, fieldOptions);

	fieldOptions.field = 'datetime';
	fieldOptions.type = 'dateTime';
	await CreateField(api, fieldOptions);

	fieldOptions.field = 'timestamp';
	fieldOptions.type = 'timestamp';
	await CreateField(api, fieldOptions);

	fieldOptions.field = 'date_created';
	fieldOptions.type = 'timestamp';
	await CreateField(api, fieldOptions);

	fieldOptions.field = 'date_updated';
	fieldOptions.type = 'timestamp';
	await CreateField(api, fieldOptions);

	await request(api.url)
		.patch(`/collections/${collectionName}`)
		.send({
			meta: {},
		})
		.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
		.expect('Content-Type', /application\/json/)
		.expect(200);

	await request(api.url)
		.patch(`/fields/${collectionName}/date_created`)
		.send({
			meta: {
				special: ['date-created'],
			},
		})
		.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
		.expect('Content-Type', /application\/json/)
		.expect(200);

	await request(api.url)
		.patch(`/fields/${collectionName}/date_updated`)
		.send({
			meta: {
				special: ['date-updated'],
			},
		})
		.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
		.expect('Content-Type', /application\/json/)
		.expect(200);

	switch (vendor) {
		case 'sqlite3':
			await request(api.url)
				.patch(`/fields/${collectionName}/timestamp`)
				.send({
					meta: {
						special: ['cast-timestamp'],
					},
				})
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
				.expect('Content-Type', /application\/json/)
				.expect(200);

			await request(api.url)
				.patch(`/fields/${collectionName}/date_created`)
				.send({
					meta: {
						special: ['date-created', 'cast-timestamp'],
					},
				})
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
				.expect('Content-Type', /application\/json/)
				.expect(200);

			await request(api.url)
				.patch(`/fields/${collectionName}/date_updated`)
				.send({
					meta: {
						special: ['date-updated', 'cast-timestamp'],
					},
				})
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
				.expect('Content-Type', /application\/json/)
				.expect(200);

			break;
		case 'oracle':
			await request(api.url)
				.patch(`/fields/${collectionName}/datetime`)
				.send({
					meta: {
						special: ['cast-datetime'],
					},
				})
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
				.expect('Content-Type', /application\/json/)
				.expect(200);

			break;
		default:
			break;
	}
}

type Timezone = { utc: string; america: string; current: string };

export function createTimezoneTest(newTz = 'UTC', americanTz = 'UTC') {
	return createIdentityTest({ env: { CACHE_SCHEMA: 'false' } }).extend<{
		timezoneState: Prerequisite<Timezone>;
		timezone: Timezone;
	}>({
		timezoneState: [
			async ({ apiState, identityState, vendor, teardownFailures }, use) => {
				if (!apiState.ok) return use(apiState);
				if (!identityState.ok) return use(identityState);
				const api = apiState.value;

				await capturePrerequisite<Timezone>(
					async (ready) => {
						await prepareTimezoneSchema(api, vendor);
						const utc = await api.start({ CACHE_SCHEMA: 'true', TZ: 'UTC' });
						const america = americanTz === 'UTC' ? utc : await api.start({ CACHE_SCHEMA: 'true', TZ: americanTz });

						let current = utc;
						if (newTz !== 'UTC')
							current = newTz === americanTz ? america : await api.start({ CACHE_SCHEMA: 'true', TZ: newTz });

						await ready({ utc: utc.url, america: america.url, current: current.url });
					},
					use,
					teardownFailures
				);
			},
			{ scope: 'file' },
		],
		timezone: [
			async ({ api, identities, timezoneState, task, skip }, use) => {
				void api;
				void identities;
				await use(requirePrerequisite(timezoneState, 'timezone schema and API processes', { task, skip }));
			},
			{ auto: true },
		],
	});
}
export async function seedTimezoneRows(api: Api, urls: string[], vendor: string) {
	await api.database(collectionName).delete();
	const dates = sampleDates.map((date) => ({ ...date }));
	if (vendor === 'oracle') for (const date of dates) delete date.time;
	for (const url of urls)
		await setupRequest(url)
			.post('/items/' + collectionName)
			.auth(USER.ADMIN.TOKEN, { type: 'bearer' })
			.send(dates)
			.expect(200);
}
