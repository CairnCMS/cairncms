import type { ItemPermissions, PermissionsAction, Query } from '@cairncms/types';
import type Keyv from 'keyv';
import { clearSystemCache, getCache } from '../cache.js';
import { appAccessMinimalPermissions } from '../database/system-data/app-access-permissions/index.js';
import { ForbiddenException, InvalidCredentialsException, InvalidPayloadException } from '../exceptions/index.js';
import { AuthorizationService } from '../services/authorization.js';
import type { QueryOptions } from '../services/items.js';
import { ItemsService } from '../services/items.js';
import type { AbstractServiceOptions, Item, MutationOptions, PrimaryKey } from '../types/index.js';
import { filterItems } from '../utils/filter-items.js';
import { validateKeys } from '../utils/validate-keys.js';

export class PermissionsService extends ItemsService {
	systemCache: Keyv<any>;

	constructor(options: AbstractServiceOptions) {
		super('directus_permissions', options);

		const { systemCache } = getCache();

		this.systemCache = systemCache;
	}

	getAllowedFields(action: PermissionsAction, collection?: string): Record<string, string[]> {
		const results =
			this.accountability?.permissions?.filter((permission) => {
				let matchesCollection = true;

				if (collection) {
					matchesCollection = permission.collection === collection;
				}

				const matchesAction = permission.action === action;

				return collection ? matchesCollection && matchesAction : matchesAction;
			}) ?? [];

		const fieldsPerCollection: Record<string, string[]> = {};

		for (const result of results) {
			const { collection, fields } = result;
			if (!fieldsPerCollection[collection]) fieldsPerCollection[collection] = [];
			fieldsPerCollection[collection]!.push(...(fields ?? []));
		}

		return fieldsPerCollection;
	}

	async getItemPermissions(collection: string, pk?: PrimaryKey): Promise<ItemPermissions> {
		if (!this.accountability?.user) throw new InvalidCredentialsException();

		const denied: ItemPermissions = {
			update: { access: false, fields: null },
			delete: { access: false },
			share: { access: false },
		};

		const isAdmin = this.accountability?.admin === true;

		if (isAdmin === false && this.hasRelevantItemPermission(collection) === false) {
			if (pk === undefined) throw new InvalidPayloadException('A primary key is required');
			return denied;
		}

		if (Object.prototype.hasOwnProperty.call(this.schema.collections, collection) === false) {
			if (pk === undefined) throw new InvalidPayloadException('A primary key is required');
			return denied;
		}

		const collectionInfo = this.schema.collections[collection]!;
		const primaryKeyField = collectionInfo.primary;
		let targetKey = pk;

		if (targetKey === undefined) {
			if (collectionInfo.singleton !== true) {
				throw new InvalidPayloadException('A primary key is required');
			}

			const row = await this.knex.select(primaryKeyField).from(collection).first();
			if (!row) return denied;
			targetKey = row[primaryKeyField];
		} else {
			try {
				validateKeys(this.schema, collection, primaryKeyField, targetKey);
			} catch (error) {
				if (error instanceof ForbiddenException) return denied;
				throw error;
			}

			if (isAdmin) {
				const row = await this.knex.select(primaryKeyField).from(collection).where(primaryKeyField, targetKey).first();

				if (!row) return denied;
			}
		}

		const authorizationService = new AuthorizationService({
			accountability: this.accountability,
			knex: this.knex,
			schema: this.schema,
		});

		const [update, remove, share] = await Promise.all([
			this.hasItemAccess(authorizationService, 'update', collection, targetKey!),
			this.hasItemAccess(authorizationService, 'delete', collection, targetKey!),
			this.hasItemAccess(authorizationService, 'share', collection, targetKey!),
		]);

		return {
			update: { access: update, fields: update ? this.getItemUpdateFields(collection) : null },
			delete: { access: remove },
			share: { access: share },
		};
	}

	private hasRelevantItemPermission(collection: string): boolean {
		return (
			this.accountability?.permissions?.some(
				(permission) =>
					permission.collection === collection &&
					(permission.action === 'update' || permission.action === 'delete' || permission.action === 'share')
			) ?? false
		);
	}

	private async hasItemAccess(
		authorizationService: AuthorizationService,
		action: PermissionsAction,
		collection: string,
		pk: PrimaryKey
	): Promise<boolean> {
		try {
			await authorizationService.checkAccess(action, collection, pk);
			return true;
		} catch (error) {
			if (error instanceof ForbiddenException) return false;
			throw error;
		}
	}

	private getItemUpdateFields(collection: string): string[] | null {
		if (this.accountability?.admin === true) return ['*'];
		return this.getAllowedFields('update', collection)[collection] ?? null;
	}

	override async readByQuery(query: Query, opts?: QueryOptions): Promise<Partial<Item>[]> {
		const result = await super.readByQuery(query, opts);

		if (Array.isArray(result) && this.accountability && this.accountability.app === true) {
			result.push(
				...filterItems(
					appAccessMinimalPermissions.map((permission) => ({
						...permission,
						role: this.accountability!.role,
					})),
					query.filter
				)
			);
		}

		return result;
	}

	override async readMany(keys: PrimaryKey[], query: Query = {}, opts?: QueryOptions): Promise<Partial<Item>[]> {
		const result = await super.readMany(keys, query, opts);

		if (this.accountability && this.accountability.app === true) {
			result.push(
				...filterItems(
					appAccessMinimalPermissions.map((permission) => ({
						...permission,
						role: this.accountability!.role,
					})),
					query.filter
				)
			);
		}

		return result;
	}

	override async createOne(data: Partial<Item>, opts?: MutationOptions) {
		const res = await super.createOne(data, opts);

		if (opts?.autoPurgeSystemCache !== false) {
			await clearSystemCache({ autoPurgeCache: opts?.autoPurgeCache });
		}

		if (this.cache && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return res;
	}

	override async createMany(data: Partial<Item>[], opts?: MutationOptions) {
		const res = await super.createMany(data, opts);

		if (opts?.autoPurgeSystemCache !== false) {
			await clearSystemCache({ autoPurgeCache: opts?.autoPurgeCache });
		}

		if (this.cache && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return res;
	}

	override async updateBatch(data: Partial<Item>[], opts?: MutationOptions) {
		const res = await super.updateBatch(data, opts);

		if (opts?.autoPurgeSystemCache !== false) {
			await clearSystemCache({ autoPurgeCache: opts?.autoPurgeCache });
		}

		if (this.cache && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return res;
	}

	override async updateMany(keys: PrimaryKey[], data: Partial<Item>, opts?: MutationOptions) {
		const res = await super.updateMany(keys, data, opts);

		if (opts?.autoPurgeSystemCache !== false) {
			await clearSystemCache({ autoPurgeCache: opts?.autoPurgeCache });
		}

		if (this.cache && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return res;
	}

	override async upsertMany(payloads: Partial<Item>[], opts?: MutationOptions) {
		const res = await super.upsertMany(payloads, opts);

		if (opts?.autoPurgeSystemCache !== false) {
			await clearSystemCache({ autoPurgeCache: opts?.autoPurgeCache });
		}

		if (this.cache && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return res;
	}

	override async deleteMany(keys: PrimaryKey[], opts?: MutationOptions) {
		const res = await super.deleteMany(keys, opts);

		if (opts?.autoPurgeSystemCache !== false) {
			await clearSystemCache({ autoPurgeCache: opts?.autoPurgeCache });
		}

		if (this.cache && opts?.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		return res;
	}
}
