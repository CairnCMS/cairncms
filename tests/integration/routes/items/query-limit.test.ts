import { setupRequest } from '../../fixtures/request';
import { describe, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PermissionsAction } from '@cairncms/types';
import type { Api } from '../../fixtures/environment';
import { createScenarioTest } from '../../fixtures/scenario';
import { describeForVendors } from '../../fixtures/applicability';
import * as common from '../../common/functions';
import { requestGraphQL } from '../../fixtures/data';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

const adminToken = common.USER.ADMIN.TOKEN;
const parentCollection = 'test_items_query_limit_parent';
const childCollection = 'test_items_query_limit_child';
const maxLimit = 10;
const parentCount = 15;
const childCount = 15;
const permsCollection = 'test_items_query_limit_perms';
const permsRoleName = 'query_limit_perms_role';
const permsUserToken = 'QueryLimitPermsToken';
const permsUserEmail = 'query-limit-perms@example.com';
const permsCount = maxLimit + 1;
const permissionActions = ['read', 'create', 'update', 'delete'] as const satisfies readonly PermissionsAction[];
const exportRunId = randomUUID();
const exportFormats = ['json', 'csv', 'xml', 'yaml'] as const;

const permissionTargets = [parentCollection, childCollection, permsCollection]
	.flatMap((collection) => permissionActions.map((action) => ({ collection, action })))
	.slice(0, permsCount);

type CleanupResult = { ok: true } | { ok: false; reason: string };

async function deleteCollection(api: Api, vendor: string, collection: string): Promise<CleanupResult> {
	try {
		const response = await request(api.url)
			.delete(`/collections/${collection}`)
			.set('Authorization', `Bearer ${api.adminToken}`);

		if (response.statusCode >= 400) {
			return { ok: false, reason: `DELETE /collections/${collection} on ${vendor} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE /collections/${collection} on ${vendor} threw ${String(error)}` };
	}
}

async function deleteResource(api: Api, vendor: string, resource: string): Promise<CleanupResult> {
	try {
		const response = await request(api.url).delete(resource).set('Authorization', `Bearer ${api.adminToken}`);

		if (response.statusCode >= 400 && response.statusCode !== 404) {
			return { ok: false, reason: `DELETE ${resource} on ${vendor} returned ${response.statusCode}` };
		}

		return { ok: true };
	} catch (error) {
		return { ok: false, reason: `DELETE ${resource} on ${vendor} threw ${String(error)}` };
	}
}

const parentIds = {} as { [vendor: string]: number };
const roleIds = {} as { [vendor: string]: string };
const userIds = {} as { [vendor: string]: string };
const seededPermissionIds = {} as { [vendor: string]: number[] };

let cappedServer: Awaited<ReturnType<Api['start']>>;

const test = createScenarioTest({
	prepare: async (api, vendor) => {
		const parent = await common.CreateCollection(api, { collection: parentCollection });
		expect(parent.collection).toBe(parentCollection);

		const child = await common.CreateCollection(api, { collection: childCollection });
		expect(child.collection).toBe(childCollection);

		const perms = await common.CreateCollection(api, { collection: permsCollection });
		expect(perms.collection).toBe(permsCollection);

		const titleField = await common.CreateField(api, {
			collection: parentCollection,
			field: 'title',
			type: 'string',
		});

		expect(titleField.field).toBe('title');

		const o2m = await common.CreateFieldO2M(api, {
			collection: parentCollection,
			field: 'children',
			otherCollection: childCollection,
			otherField: 'parent',
		});

		expect(o2m.relation).toBeDefined();

		const parents = await common.CreateItem(api, {
			collection: parentCollection,
			item: Array.from({ length: parentCount }, (_, index) => ({ title: `parent-${index}` })),
		});

		expect(parents).toHaveLength(parentCount);

		const parentId = parents[0].id;
		parentIds[vendor] = parentId;

		const children = await common.CreateItem(api, {
			collection: childCollection,
			item: Array.from({ length: childCount }, () => ({ parent: parentId })),
		});

		expect(children).toHaveLength(childCount);

		const role = await common.CreateRole(api, {
			name: permsRoleName,
			appAccessEnabled: true,
			adminAccessEnabled: false,
		});

		expect(role.id).toBeDefined();
		roleIds[vendor] = role.id;

		const user = await common.CreateUser(api, {
			token: permsUserToken,
			email: permsUserEmail,
			role: role.id,
		});

		expect(user.id).toBeDefined();
		userIds[vendor] = user.id;

		const permissionIds: number[] = [];

		for (const target of permissionTargets) {
			const created = await setupRequest(api.url)
				.post('/permissions')
				.set('Authorization', `Bearer ${adminToken}`)
				.send({ role: role.id, collection: target.collection, action: target.action, fields: ['*'] });

			expect(created.statusCode).toBe(200);
			permissionIds.push(created.body.data.id);
		}

		expect(permissionIds).toHaveLength(permsCount);
		seededPermissionIds[vendor] = permissionIds;

		cappedServer = await api.start({ QUERY_LIMIT_MAX: String(maxLimit) });
	},
	cleanup: async (api, vendor) => {
		if (cappedServer) await api.stop(cappedServer.child);
		const vendorFailures: string[] = [];

		// Sweep by the run-unique prefix so an assertion failure between an export POST
		// and its ID capture cannot strand an artifact for later runs.
		const sweep = await request(api.url)
			.get('/files')
			.query({ 'filter[title][_starts_with]': `export-ql-${exportRunId}-`, fields: 'id', limit: -1 })
			.set('Authorization', `Bearer ${adminToken}`);

		if (sweep.statusCode >= 400) {
			vendorFailures.push(`export file sweep on ${vendor} returned ${sweep.statusCode}`);
		}

		for (const file of (sweep.body.data ?? []) as { id: string }[]) {
			const result = await deleteResource(api, vendor, `/files/${file.id}`);
			if (!result.ok) vendorFailures.push(result.reason);
		}

		// Delete the user before its role; role deletion drops the seeded permission rows.
		if (userIds[vendor]) {
			const result = await deleteResource(api, vendor, `/users/${userIds[vendor]}`);
			if (!result.ok) vendorFailures.push(result.reason);
		}

		if (roleIds[vendor]) {
			const result = await deleteResource(api, vendor, `/roles/${roleIds[vendor]}`);
			if (!result.ok) vendorFailures.push(result.reason);
		}

		// Drop the child collection before the parent so the m2o relation is gone first.
		for (const collection of [childCollection, parentCollection, permsCollection]) {
			const result = await deleteCollection(api, vendor, collection);
			if (!result.ok) vendorFailures.push(result.reason);
		}

		if (vendorFailures.length) throw new Error('Query limit teardown failures: ' + vendorFailures.join('; '));
	},
});

describe('/items QUERY_LIMIT_MAX enforcement', () => {
	describeForVendors(
		`caps reads at a configured maximum of ${maxLimit}`,
		['postgres', 'postgres10', 'mysql', 'mysql5', 'maria'],
		'Query-limit configurations have not been validated on SQLite.',
		() => {
			test('caps an unlimited top-level read at the maximum', async ({ api }) => {
				const uncapped = await request(api.url)
					.get(`/items/${parentCollection}`)
					.query({ limit: -1, fields: 'id' })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(uncapped.body.data).toHaveLength(parentCount);

				const capped = await request(cappedServer.url)
					.get(`/items/${parentCollection}`)
					.query({ limit: -1, fields: 'id' })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(capped.body.data).toHaveLength(maxLimit);
			});

			test('rejects a top-level limit above the maximum with INVALID_QUERY', async () => {
				const response = await request(cappedServer.url)
					.get(`/items/${parentCollection}`)
					.query({ limit: maxLimit + 1 })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('INVALID_QUERY');
			});

			test('caps a relational child read at the maximum', async ({ api, vendor }) => {
				const parentId = parentIds[vendor];

				const capped = await request(cappedServer.url)
					.get(`/items/${parentCollection}/${parentId}`)
					.query({ fields: 'id,children.id' })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(capped.body.data.children).toHaveLength(maxLimit);

				const uncapped = await request(api.url)
					.get(`/items/${parentCollection}/${parentId}`)
					.query({ fields: 'id,children.id' })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(uncapped.body.data.children).toHaveLength(childCount);
			});

			test('enforces the maximum on a SEARCH body limit', async () => {
				const atMax = await request(cappedServer.url)
					.search(`/items/${parentCollection}`)
					.send({ query: { limit: maxLimit, fields: ['id'] } })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(atMax.statusCode).toBe(200);
				expect(atMax.body.data).toHaveLength(maxLimit);

				const overMax = await request(cappedServer.url)
					.search(`/items/${parentCollection}`)
					.send({ query: { limit: maxLimit + 1 } })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(overMax.statusCode).toBe(400);
				expect(overMax.body.errors[0].extensions.code).toBe('INVALID_QUERY');
			});

			test('enforces the maximum on a nested GraphQL limit', async ({ vendor }) => {
				const parentId = parentIds[vendor];

				const overMax = await requestGraphQL(cappedServer.url, false, adminToken, {
					query: {
						[parentCollection]: {
							__args: { filter: { id: { _eq: parentId } } },
							children: {
								__args: { limit: maxLimit + 1 },
								id: true,
							},
						},
					},
				});

				expect(overMax.body.errors).toBeDefined();
				expect(overMax.body.errors[0].extensions.code).toBe('INVALID_QUERY');

				const atMax = await requestGraphQL(cappedServer.url, false, adminToken, {
					query: {
						[parentCollection]: {
							__args: { filter: { id: { _eq: parentId } } },
							children: {
								__args: { limit: maxLimit },
								id: true,
							},
						},
					},
				});

				expect(atMax.body.errors).toBeUndefined();
				expect(atMax.body.data[parentCollection][0].children).toHaveLength(maxLimit);
			});

			test("returns a role's full permission set to an app user despite the maximum", async ({ vendor }) => {
				const response = await request(cappedServer.url)
					.get('/permissions')
					.query({ 'filter[role][_eq]': roleIds[vendor] })
					.set('Authorization', `Bearer ${permsUserToken}`);

				expect(response.statusCode).toBe(200);

				// App-access permissions are synthetic and carry no ID; only stored rows do.
				const storedIds = (response.body.data as { id?: number }[])
					.map((permission) => permission.id)
					.filter((id): id is number => typeof id === 'number');

				expect(storedIds.slice().sort((a, b) => a - b)).toEqual(
					seededPermissionIds[vendor]!.slice().sort((a, b) => a - b)
				);
			});

			function exportTitle(caseName: string, vendor: string) {
				return `export-ql-${exportRunId}-${caseName}-${vendor}`;
			}

			async function postExport(url: string, body: Record<string, unknown>) {
				return await request(url)
					.post(`/utils/export/${parentCollection}`)
					.send(body)
					.set('Authorization', `Bearer ${adminToken}`);
			}

			async function findExportFile(
				url: string,
				title: string
			): Promise<{ id: string; filename_disk: string | null; filesize: string | number | null } | null> {
				const response = await request(url)
					.get('/files')
					.query({ 'filter[title][_eq]': title, fields: 'id,filename_disk,filesize' })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(response.statusCode).toBe(200);

				return response.body.data?.[0] ?? null;
			}

			async function waitForExportFile(url: string, title: string, timeoutMs = 10000): Promise<{ id: string } | null> {
				const started = performance.now();

				do {
					const row = await findExportFile(url, title);

					// Background exports create a placeholder before storing the bytes and final metadata.
					// A zero-byte CSV is complete too; rejected-export checks still detect any row.
					if (row?.filename_disk && row.filesize !== null && row.filesize !== undefined) return row;

					await new Promise((resolve) => setTimeout(resolve, 250));
				} while (performance.now() - started < timeoutMs);

				return null;
			}

			async function downloadExport(url: string, id: string) {
				const response = await request(url).get(`/assets/${id}`).set('Authorization', `Bearer ${adminToken}`);

				expect(response.statusCode).toBe(200);

				return response;
			}

			async function deleteExportFile(url: string, id: string) {
				const response = await request(url).delete(`/files/${id}`).set('Authorization', `Bearer ${adminToken}`);

				expect(response.statusCode).toBeLessThan(400);
			}

			async function runJsonExport(url: string, title: string, query: Record<string, unknown>) {
				const response = await postExport(url, { query, format: 'json', file: { title } });

				expect(response.statusCode).toBe(204);

				const file = await waitForExportFile(url, title);

				expect(file).not.toBeNull();

				const download = await downloadExport(url, file!.id);
				await deleteExportFile(url, file!.id);

				return download.body as { id: number; title?: string }[];
			}

			async function seededParentIds(api: Api, filter?: Record<string, unknown>): Promise<number[]> {
				const response = await request(api.url)
					.get(`/items/${parentCollection}`)
					.query({ limit: -1, fields: 'id', ...(filter && { filter: JSON.stringify(filter) }) })
					.set('Authorization', `Bearer ${adminToken}`);

				expect(response.statusCode).toBe(200);

				return (response.body.data as { id: number }[]).map((row) => row.id).sort((a, b) => a - b);
			}

			test('exports every row to the file library despite the maximum', async ({ api, vendor }) => {
				const url = cappedServer.url;

				const rows = await runJsonExport(url, exportTitle('unlimited', vendor), { limit: -1, fields: ['id'] });

				expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(await seededParentIds(api));
			}, 30000);

			test('exports every filtered row when the limit is omitted', async ({ api, vendor }) => {
				const url = cappedServer.url;
				const filter = { title: { _nin: ['parent-0', 'parent-1', 'parent-2'] } };

				const rows = await runJsonExport(url, exportTitle('omitted', vendor), {
					filter,
					fields: ['id', 'title'],
				});

				const expectedIds = await seededParentIds(api, filter);

				expect(expectedIds).toHaveLength(parentCount - 3);
				expect(rows.map((row) => row.id).sort((a, b) => a - b)).toEqual(expectedIds);
			}, 30000);

			test('exports every row when the limit is null', async ({ vendor }) => {
				const url = cappedServer.url;

				const rows = await runJsonExport(url, exportTitle('null', vendor), { limit: null, fields: ['id'] });

				expect(rows).toHaveLength(parentCount);
			}, 30000);

			test('caps the export at an explicit limit below the maximum', async ({ vendor }) => {
				const url = cappedServer.url;

				const rows = await runJsonExport(url, exportTitle('explicit', vendor), { limit: 5, fields: ['id'] });

				expect(rows).toHaveLength(5);
			}, 30000);

			test('honors an explicit limit above the maximum', async ({ vendor }) => {
				const url = cappedServer.url;

				const rows = await runJsonExport(url, exportTitle('over-max', vendor), { limit: 5000, fields: ['id'] });

				expect(rows).toHaveLength(parentCount);
			}, 30000);

			test("accepts a numeric string limit of '-1'", async ({ vendor }) => {
				const url = cappedServer.url;

				const rows = await runJsonExport(url, exportTitle('string-sentinel', vendor), {
					limit: '-1',
					fields: ['id'],
				});

				expect(rows).toHaveLength(parentCount);
			}, 30000);

			test('exports every row without a configured maximum', async ({ api, vendor }) => {
				const url = api.url;

				const rows = await runJsonExport(url, exportTitle('no-max', vendor), { limit: -1, fields: ['id'] });

				expect(rows).toHaveLength(parentCount);
			}, 30000);

			test('produces a valid empty export for a limit of 0 in every format', async ({ vendor }) => {
				const url = cappedServer.url;

				for (const format of exportFormats) {
					const title = exportTitle(`zero-${format}`, vendor);
					const response = await postExport(url, { query: { limit: 0 }, format, file: { title } });

					expect(response.statusCode).toBe(204);

					const file = await waitForExportFile(url, title);

					expect(file).not.toBeNull();

					const download = await downloadExport(url, file!.id);
					await deleteExportFile(url, file!.id);

					if (format === 'json') expect(download.body).toEqual([]);
					if (format === 'csv') expect(download.text ?? '').toBe('');
					if (format === 'xml') expect(download.text).toBe("<?xml version='1.0'?>\n<data/>");
					if (format === 'yaml') expect(download.text.trim()).toBe('[]');
				}
			}, 60000);

			test('rejects invalid export limits with INVALID_QUERY', async ({ vendor }) => {
				const url = cappedServer.url;
				const invalidLimits: unknown[] = [-2, 1.5, 'abc', true, [], ''];

				for (const limit of invalidLimits) {
					const response = await postExport(url, {
						query: { limit },
						format: 'json',
						file: { title: exportTitle('rejected', vendor) },
					});

					expect(response.statusCode).toBe(400);
					expect(response.body.errors[0].extensions.code).toBe('INVALID_QUERY');
				}

				// A rejected request must never schedule the background export, so absence is
				// asserted across the same completion window successful exports are allowed.
				const started = Date.now();

				while (Date.now() - started < 10000) {
					expect(await findExportFile(url, exportTitle('rejected', vendor))).toBeNull();
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}, 30000);

			test('rejects a nested limit above the maximum', async ({ vendor }) => {
				const url = cappedServer.url;

				const response = await postExport(url, {
					query: { limit: -1, deep: { children: { _limit: maxLimit + 1 } } },
					format: 'json',
					file: { title: exportTitle('deep', vendor) },
				});

				expect(response.statusCode).toBe(400);
				expect(response.body.errors[0].extensions.code).toBe('INVALID_QUERY');
			});
		}
	);
});
