import { expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import { initializeFixtures } from '../fixture-setup.mjs';

initializeFixtures();

test('worker SQL Date bindings and the base API share UTC', async ({ api, vendor }) => {
	expect(process.env.TZ).toBe('UTC');
	expect(new Date('2020-01-02T03:04:05Z').getTimezoneOffset()).toBe(0);

	if (['mysql', 'mysql5', 'maria'].includes(vendor)) {
		await api.database.schema.createTable('clock_fixture', (table) => {
			table.dateTime('value');
		});

		await api.database('clock_fixture').insert({ value: new Date('2020-01-02T03:04:05Z') });

		const [rows] = await api.database.raw(
			"SELECT DATE_FORMAT(value, '%Y-%m-%d %H:%i:%s') AS serialized FROM clock_fixture"
		);

		expect(rows[0].serialized).toBe('2020-01-02 03:04:05');
	}
});
