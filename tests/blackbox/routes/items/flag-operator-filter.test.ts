import request from 'supertest';
import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import * as common from '@common/index';
import { collection, restrictedUser, seedDBValues, TENANT_A } from './flag-operator-filter.seed';

let isSeeded = false;

beforeAll(async () => {
	isSeeded = await seedDBValues();
}, 300000);

test('Seed Database Values', () => {
	expect(isSeeded).toStrictEqual(true);
});

describe('flag operator filter semantics', () => {
	describe('permission filter with _null false scopes a restricted role to non-null rows', () => {
		it.each(vendors)('%s', async (vendor) => {
			const response = await request(getUrl(vendor))
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
		it.each(vendors)('%s', async (vendor) => {
			const response = await request(getUrl(vendor))
				.get(`/items/${collection}?filter[label][_null]=false&fields=label`)
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(2);
			expect(response.body.data.every((row: { label: string | null }) => row.label !== null)).toBe(true);
		});
	});

	describe('caller filter with an empty _null value is accepted and returns the null rows', () => {
		it.each(vendors)('%s', async (vendor) => {
			const response = await request(getUrl(vendor))
				.get(`/items/${collection}?filter[label][_null]=&fields=label`)
				.set('Authorization', `Bearer ${common.USER.ADMIN.TOKEN}`);

			expect(response.statusCode).toEqual(200);
			expect(response.body.data.length).toBe(1);
			expect(response.body.data[0].label).toBeNull();
		});
	});
});
