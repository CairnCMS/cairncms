import { getUrl } from '@common/config';
import vendors from '@common/get-dbs-to-test';
import { USER } from '@common/variables';
import request from 'supertest';

describe('/extensions', () => {
	describe('GET /extensions (admin diagnostic inventory)', () => {
		it.each(vendors)('%s reports failed and loaded extensions truthfully', async (vendor) => {
			const response = await request(getUrl(vendor))
				.get('/extensions')
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
				.expect(200);

			const byName: Record<
				string,
				{
					status: string;
					version?: string;
					entries?: { name: string; type: string }[];
					reason?: { code: string; detail: string };
					settings?: { status: string; reason?: { code: string; detail: string } };
				}
			> = {};

			for (const entry of response.body.data) {
				byName[entry.name] = entry;
			}

			expect(byName['cairn-broken']?.status).toBe('failed');
			expect(byName['cairn-broken']?.reason?.detail).not.toContain('/opt/secret/path');
			expect(byName['cairn-broken']?.version).toBeUndefined();

			expect(byName['cairncms-extension-cairn-badmanifest']?.status).toBe('failed');

			expect(byName['cairncms-extension-cairn-scoped']?.status).toBe('loaded');
			expect(byName['cairncms-extension-cairn-scoped']?.version).toBe('1.0.0');

			const fixtureBundle = byName['cairncms-extension-fixture-bundle'];
			expect(fixtureBundle?.status).toBe('loaded');
			expect(fixtureBundle?.version).toBe('1.0.0');
			expect(fixtureBundle?.entries).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ name: 'cairn-fixture-bundle-interface', type: 'interface' }),
					expect.objectContaining({ name: 'cairn-fixture-bundle-endpoint', type: 'endpoint' }),
				])
			);

			// The suite runs SERVE_APP=false, so the app fixture proves the listing is
			// topology-complete: found on this instance, not served by it.
			expect(byName['cairn-fixture-interface']?.status).toBe('discovered');

			expect(byName['cairncms-extension-settings-fixture']?.settings).toEqual({ status: 'available' });
			expect(byName['bad-subject']?.settings).toEqual({
				status: 'unavailable',
				reason: expect.objectContaining({ code: 'settings-subject-invalid' }),
			});

			expect(JSON.stringify(response.body)).not.toContain('CAIRNCMS_EXT_');
		});

		it.each(vendors)('%s rejects a non-admin request', async (vendor) => {
			await request(getUrl(vendor)).get('/extensions').expect(403);
		});
	});

	describe('package-scoped resolution through the real loader', () => {
		it.each(vendors)('%s resolves a package-scoped import from the extension package', async (vendor) => {
			const response = await request(getUrl(vendor))
				.get('/cairncms-extension-cairn-scoped/marker')
				.set('Authorization', `Bearer ${USER.ADMIN.TOKEN}`)
				.expect(200);

			expect(response.body.marker).toBe('CAIRN_SCOPED_OK');
		});
	});
});
