import { describe, expect } from 'vitest';
import { createSeededTest } from '../../fixtures/seeded';
import request from '../../fixtures/request';

import * as common from '../../fixtures/seeded';
import { collection, restrictedUser, seedDBValues, seedDBStructure, TENANT_A } from './flag-operator-filter.seed';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const test = createSeededTest({ seedDBStructure, seedDBValues, tables: ['test_items_flag_operator_filter'] });

test('Seed Database Values', async ({ isSeeded }) => {
	expect(isSeeded).toStrictEqual(true);
});

describe('flag operator filter semantics', () => {
	describe('permission filter with _null false scopes a restricted role to non-null rows', () => {
		test('REST', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}`)
				.query({ fields: 'tenant,label' })
				.set('Authorization', `Bearer ${restrictedUser.token}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(1);
			expect(response.body.data[0].tenant).toBe(TENANT_A);
			expect(response.body.data[0].label).not.toBeNull();
		});
	});

	describe('caller filter _null=false returns the non-null rows over the raw query string', () => {
		test('REST', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}?filter[label][_null]=false&fields=label`)
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(2);
			expect(response.body.data.every((row: { label: string | null }) => row.label !== null)).toBe(true);
		});
	});

	describe('caller filter with an empty _null value is accepted and returns the null rows', () => {
		test('REST', async ({ api }) => {
			const response = await request(api.url)
				.get(`/items/${collection}?filter[label][_null]=&fields=label`)
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(1);
			expect(response.body.data[0].label).toBeNull();
		});
	});
});
