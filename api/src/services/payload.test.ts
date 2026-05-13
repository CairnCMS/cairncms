import type { Knex } from 'knex';
import knex from 'knex';
import { MockClient, Tracker, createTracker } from 'knex-mock-client';
import type { MockedFunction } from 'vitest';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Helpers } from '../../src/database/helpers/index.js';
import { getHelpers } from '../../src/database/helpers/index.js';
import { PayloadService } from '../../src/services/index.js';

vi.mock('../../src/database/index', () => ({
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
}));

describe('Integration Tests', () => {
	let db: MockedFunction<Knex>;
	let tracker: Tracker;

	beforeAll(async () => {
		db = vi.mocked(knex.default({ client: MockClient }));
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
	});

	describe('Services / PayloadService', () => {
		describe('transformers', () => {
			let service: PayloadService;
			let helpers: Helpers;

			beforeEach(() => {
				service = new PayloadService('test', {
					knex: db,
					schema: { collections: {}, relations: [] },
				});

				helpers = getHelpers(db);
			});

			describe('csv', () => {
				it('Returns undefined for illegal values', async () => {
					const result = await service.transformers['cast-csv']!({
						value: 123,
						action: 'read',
						payload: {},
						accountability: { role: null },
						specials: [],
						helpers,
					});

					expect(result).toBe(undefined);
				});

				it('Returns [] for empty strings', async () => {
					const result = await service.transformers['cast-csv']!({
						value: '',
						action: 'read',
						payload: {},
						accountability: { role: null },
						specials: [],
						helpers,
					});

					expect(result).toMatchObject([]);
				});

				it('Returns array values as is', async () => {
					const result = await service.transformers['cast-csv']!({
						value: ['test', 'example'],
						action: 'read',
						payload: {},
						accountability: { role: null },
						specials: [],
						helpers,
					});

					expect(result).toEqual(['test', 'example']);
				});

				it('Splits the CSV string', async () => {
					const result = await service.transformers['cast-csv']!({
						value: 'test,example',
						action: 'read',
						payload: {},
						accountability: { role: null },
						specials: [],
						helpers,
					});

					expect(result).toMatchObject(['test', 'example']);
				});

				it('Saves array values as joined string', async () => {
					const result = await service.transformers['cast-csv']!({
						value: ['test', 'example'],
						action: 'create',
						payload: {},
						accountability: { role: null },
						specials: [],
						helpers,
					});

					expect(result).toBe('test,example');
				});

				it('Saves string values as is', async () => {
					const result = await service.transformers['cast-csv']!({
						value: 'test,example',
						action: 'create',
						payload: {},
						accountability: { role: null },
						specials: [],
						helpers,
					});

					expect(result).toBe('test,example');
				});
			});
		});

		describe('processDates', () => {
			let service: PayloadService;

			const dateFieldId = 'date_field';
			const dateTimeFieldId = 'datetime_field';
			const timestampFieldId = 'timestamp_field';

			beforeEach(() => {
				service = new PayloadService('test', {
					knex: db,
					schema: {
						collections: {
							test: {
								collection: 'test',
								primary: 'id',
								singleton: false,
								sortField: null,
								note: null,
								accountability: null,
								fields: {
									[dateFieldId]: {
										field: dateFieldId,
										defaultValue: null,
										nullable: true,
										generated: false,
										type: 'date',
										dbType: 'date',
										precision: null,
										scale: null,
										special: [],
										note: null,
										validation: null,
										alias: false,
									},
									[dateTimeFieldId]: {
										field: dateTimeFieldId,
										defaultValue: null,
										nullable: true,
										generated: false,
										type: 'dateTime',
										dbType: 'datetime',
										precision: null,
										scale: null,
										special: [],
										note: null,
										validation: null,
										alias: false,
									},
									[timestampFieldId]: {
										field: timestampFieldId,
										defaultValue: null,
										nullable: true,
										generated: false,
										type: 'timestamp',
										dbType: 'timestamp',
										precision: null,
										scale: null,
										special: [],
										note: null,
										validation: null,
										alias: false,
									},
								},
							},
						},
						relations: [],
					},
				});
			});

			describe('processes dates', () => {
				it('with zero values', () => {
					const result = service.processDates(
						[
							{
								[dateFieldId]: '0000-00-00',
								[dateTimeFieldId]: '0000-00-00 00:00:00',
								[timestampFieldId]: '0000-00-00 00:00:00.000',
							},
						],
						'read'
					);

					expect(result).toMatchObject([
						{
							[dateFieldId]: null,
							[dateTimeFieldId]: null,
							[timestampFieldId]: null,
						},
					]);
				});

				it('with typical values', () => {
					const result = service.processDates(
						[
							{
								[dateFieldId]: '2022-01-10',
								[dateTimeFieldId]: '2021-09-31 12:34:56',
								[timestampFieldId]: '1980-12-08 00:11:22.333',
							},
						],
						'read'
					);

					expect(result).toMatchObject([
						{
							[dateFieldId]: '2022-01-10',
							[dateTimeFieldId]: '2021-10-01T12:34:56',
							[timestampFieldId]: new Date('1980-12-08 00:11:22.333').toISOString(),
						},
					]);
				});

				it('with date object values', () => {
					const result = service.processDates(
						[
							{
								[dateFieldId]: new Date(1666777777000),
								[dateTimeFieldId]: new Date(1666666666000),
								[timestampFieldId]: new Date(1666555444333),
							},
						],
						'read'
					);

					expect(result).toMatchObject([
						{
							[dateFieldId]: toLocalISOString(new Date(1666777777000)).slice(0, 10),
							[dateTimeFieldId]: toLocalISOString(new Date(1666666666000)),
							[timestampFieldId]: new Date(1666555444333).toISOString(),
						},
					]);
				});
			});
		});

		describe('processValues — conceal masking on aggregate keys', () => {
			function makeService() {
				const field = (name: string, special: string[] = []) =>
					({
						field: name,
						defaultValue: null,
						nullable: true,
						generated: false,
						type: 'string' as const,
						dbType: 'varchar',
						precision: null,
						scale: null,
						special,
						note: null,
						validation: null,
						alias: false,
					} as any);

				return new PayloadService('test', {
					knex: db,
					schema: {
						collections: {
							test: {
								collection: 'test',
								primary: 'id',
								singleton: false,
								sortField: null,
								note: null,
								accountability: null,
								fields: {
									id: field('id'),
									status: field('status'),
									tfa_secret: field('tfa_secret', ['conceal']),
									token: field('token', ['conceal']),
									password: field('password', ['conceal']),
								},
							},
						},
						relations: [],
					},
				});
			}

			it.each([
				['min', 'tfa_secret', 'raw-secret'],
				['max', 'tfa_secret', 'raw-secret'],
				['min', 'token', 'raw-token'],
				['max', 'password', 'raw-password'],
				['sum', 'tfa_secret', 'raw-secret'],
				['sumDistinct', 'tfa_secret', 'raw-secret'],
				['avg', 'tfa_secret', 'raw-secret'],
				['avgDistinct', 'tfa_secret', 'raw-secret'],
			])('masks value-deriving aggregate %s on %s', async (op, fieldName, raw) => {
				const service = makeService();
				const flatKey = `${op}->${fieldName}`;

				const result = (await service.processValues('read', [{ [flatKey]: raw }])) as any[];

				expect(result[0][op][fieldName]).toBe('**********');
			});

			it.each([
				['count', 'tfa_secret', 5],
				['countDistinct', 'tfa_secret', 3],
				['countAll', 'tfa_secret', 7],
			])('does not mask count-style aggregate %s on %s', async (op, fieldName, count) => {
				const service = makeService();
				const flatKey = `${op}->${fieldName}`;

				const result = (await service.processValues('read', [{ [flatKey]: count }])) as any[];

				expect(result[0][op][fieldName]).toBe(count);
			});

			it.each([
				['min', 'status', 'active'],
				['max', 'id', 42],
			])('does not mask aggregate %s on non-concealed field %s', async (op, fieldName, value) => {
				const service = makeService();
				const flatKey = `${op}->${fieldName}`;

				const result = (await service.processValues('read', [{ [flatKey]: value }])) as any[];

				expect(result[0][op][fieldName]).toBe(value);
			});

			it('masks a numeric zero result on a concealed aggregate without corrupting it to null', async () => {
				const service = makeService();

				const result = (await service.processValues('read', [{ 'sum->tfa_secret': 0 }])) as any[];

				expect(result[0].sum.tfa_secret).toBe('**********');
			});

			it('passes null aggregate values through unchanged', async () => {
				const service = makeService();

				const result = (await service.processValues('read', [{ 'min->tfa_secret': null }])) as any[];

				expect(result[0].min.tfa_secret).toBeNull();
			});

			it('still masks plain non-aggregate reads of concealed fields (regression)', async () => {
				const service = makeService();

				const result = (await service.processValues('read', [{ tfa_secret: 'raw-secret' }])) as any[];

				expect(result[0].tfa_secret).toBe('**********');
			});

			it('masks concealed aggregates in every row of a grouped result', async () => {
				const service = makeService();

				const result = (await service.processValues('read', [
					{ 'min->tfa_secret': 'secret-A', 'max->tfa_secret': 'secret-Z', id: 1 },
					{ 'min->tfa_secret': 'secret-B', 'max->tfa_secret': 'secret-Y', id: 2 },
				])) as any[];

				for (const row of result) {
					expect(row.min.tfa_secret).toBe('**********');
					expect(row.max.tfa_secret).toBe('**********');
				}

				expect(result[0].id).toBe(1);
				expect(result[1].id).toBe(2);
			});
		});

		describe('processValues — conceal masking on query aliases (GHSA-p8v3-m643-4xqx)', () => {
			function makeService(collectionName: string, fieldConfigs: Array<[string, string[]?]>) {
				const field = (name: string, special: string[] = []) =>
					({
						field: name,
						defaultValue: null,
						nullable: true,
						generated: false,
						type: 'string' as const,
						dbType: 'varchar',
						precision: null,
						scale: null,
						special,
						note: null,
						validation: null,
						alias: false,
					} as any);

				const fields: Record<string, any> = {};

				for (const [name, special] of fieldConfigs) {
					fields[name] = field(name, special ?? []);
				}

				return new PayloadService(collectionName, {
					knex: db,
					schema: {
						collections: {
							[collectionName]: {
								collection: collectionName,
								primary: 'id',
								singleton: false,
								sortField: null,
								note: null,
								accountability: null,
								fields,
							},
						},
						relations: [],
					},
				});
			}

			function usersService() {
				return makeService('directus_users', [
					['id'],
					['email'],
					['password', ['conceal']],
					['tfa_secret', ['conceal']],
					['token', ['conceal']],
				]);
			}

			function sharesService() {
				return makeService('directus_shares', [['id'], ['password', ['conceal']]]);
			}

			it('masks an aliased concealed field', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ hash: 'raw-hash' }], { hash: 'password' })) as any[];

				expect(result[0].hash).toBe('**********');
			});

			it('does not mask an aliased non-concealed field', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ display_email: 'a@b.com' }], {
					display_email: 'email',
				})) as any[];

				expect(result[0].display_email).toBe('a@b.com');
			});

			it('masks multiple concealed aliases in a single payload', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ h: 'raw-hash', e: 'a@b.com' }], {
					h: 'password',
					e: 'email',
				})) as any[];

				expect(result[0].h).toBe('**********');
				expect(result[0].e).toBe('a@b.com');
			});

			it('still masks canonical concealed reads when no alias map is provided', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ password: 'raw-hash' }])) as any[];

				expect(result[0].password).toBe('**********');
			});

			it('still masks canonical concealed reads when alias map is empty', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ password: 'raw-hash' }], {})) as any[];

				expect(result[0].password).toBe('**********');
			});

			it('does not mask when alias target is not in the collection schema', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ x: 'value' }], { x: 'no_such_field' })) as any[];

				expect(result[0].x).toBe('value');
			});

			it('preserves null aliased concealed value as null', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ hash: null }], { hash: 'password' })) as any[];

				expect(result[0].hash).toBeNull();
			});

			it('masks empty-string aliased concealed value', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ hash: '' }], { hash: 'password' })) as any[];

				expect(result[0].hash).toBe('**********');
			});

			it('masks aliased concealed values across multiple rows', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ hash: 'raw-1' }, { hash: 'raw-2' }], {
					hash: 'password',
				})) as any[];

				expect(result[0].hash).toBe('**********');
				expect(result[1].hash).toBe('**********');
			});

			it('masks aliased concealed field on directus_shares (multi-collection coverage)', async () => {
				const service = sharesService();

				const result = (await service.processValues('read', [{ shared_pwd: 'raw-share-hash' }], {
					shared_pwd: 'password',
				})) as any[];

				expect(result[0].shared_pwd).toBe('**********');
			});

			it('masks both canonical and aliased concealed values in the same payload', async () => {
				const service = usersService();

				const result = (await service.processValues('read', [{ password: 'raw1', hash: 'raw2' }], {
					hash: 'password',
				})) as any[];

				expect(result[0].password).toBe('**********');
				expect(result[0].hash).toBe('**********');
			});

			it('masks a nested level when its own collection-scoped alias map is passed in (per-level seam, not a propagation test)', async () => {
				const parentService = usersService();
				const childService = sharesService();

				const parentResult = (await parentService.processValues('read', [{ id: 'u1', email: 'a@b.com' }])) as any[];
				expect(parentResult[0].id).toBe('u1');
				expect(parentResult[0].email).toBe('a@b.com');

				const childResult = (await childService.processValues('read', [{ shared_pwd: 'raw-share-hash' }], {
					shared_pwd: 'password',
				})) as any[];

				expect(childResult[0].shared_pwd).toBe('**********');
			});
		});
	});
});

function toLocalISOString(date: Date) {
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	const hours = String(date.getHours()).padStart(2, '0');
	const minutes = String(date.getMinutes()).padStart(2, '0');
	const seconds = String(date.getSeconds()).padStart(2, '0');

	return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;
}
