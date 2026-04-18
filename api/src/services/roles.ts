import type { Query } from '@directus/types';
import { normalizeRoleKey } from '@directus/utils';
import { ForbiddenException, InvalidPayloadException, UnprocessableEntityException } from '../exceptions/index.js';
import type { AbstractServiceOptions, Alterations, Item, MutationOptions, PrimaryKey } from '../types/index.js';
import { ItemsService } from './items.js';
import { PermissionsService } from './permissions.js';
import { PresetsService } from './presets.js';
import { UsersService } from './users.js';

export class RolesService extends ItemsService {
	constructor(options: AbstractServiceOptions) {
		super('directus_roles', options);
	}

	private resolveKey(name: string, usedKeys: Set<string>): string {
		let candidate = normalizeRoleKey(name);
		if (candidate === '') candidate = 'role';

		let key = candidate;
		let suffix = 2;

		while (usedKeys.has(key) || RolesService.RESERVED_KEYS.has(key)) {
			key = `${candidate}_${suffix}`;
			suffix++;
		}

		usedKeys.add(key);
		return key;
	}

	private static readonly RESERVED_KEYS = new Set(['public']);

	private validateKey(key: string): void {
		if (!key || normalizeRoleKey(key) !== key) {
			throw new InvalidPayloadException(
				`Invalid role key "${key}". Keys must be lowercase alphanumeric with underscores, and cannot start with a digit.`
			);
		}

		if (RolesService.RESERVED_KEYS.has(key)) {
			throw new InvalidPayloadException(`Role key "${key}" is reserved for config-as-code. Choose a different name.`);
		}
	}

	private async assertKeyUnchanged(id: PrimaryKey, newKey: unknown): Promise<void> {
		if (newKey === undefined) return;

		const row = await this.knex('directus_roles').select('key').where({ id }).first();

		if (row && row.key !== newKey) {
			throw new InvalidPayloadException(
				`Role key cannot be changed after creation. Delete and recreate the role instead.`
			);
		}
	}

	override async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		if (data['key']) {
			this.validateKey(data['key']);
		} else {
			if (!data['name']) {
				throw new InvalidPayloadException('Role must have a name or a key.');
			}

			const existing = await this.knex('directus_roles').select('key');
			const usedKeys = new Set(existing.map((r: any) => r.key as string));
			data['key'] = this.resolveKey(data['name'], usedKeys);
		}

		return super.createOne(data, opts);
	}

	override async createMany(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		const existing = await this.knex('directus_roles').select('key');
		const usedKeys = new Set(existing.map((r: any) => r.key as string));

		for (const item of data) {
			if (item['key']) {
				this.validateKey(item['key']);

				if (usedKeys.has(item['key'])) {
					throw new InvalidPayloadException(`Duplicate role key "${item['key']}".`);
				}

				usedKeys.add(item['key']);
			} else {
				if (!item['name']) {
					throw new InvalidPayloadException('Role must have a name or a key.');
				}

				item['key'] = this.resolveKey(item['name'], usedKeys);
			}
		}

		return super.createMany(data, opts);
	}

	private async checkForOtherAdminRoles(excludeKeys: PrimaryKey[]): Promise<void> {
		// Make sure there's at least one admin role left after this deletion is done
		const otherAdminRoles = await this.knex
			.count('*', { as: 'count' })
			.from('directus_roles')
			.whereNotIn('id', excludeKeys)
			.andWhere({ admin_access: true })
			.first();

		const otherAdminRolesCount = +(otherAdminRoles?.count || 0);
		if (otherAdminRolesCount === 0) throw new UnprocessableEntityException(`You can't delete the last admin role.`);
	}

	private async checkForOtherAdminUsers(key: PrimaryKey, users: Alterations | Item[]): Promise<void> {
		const role = await this.knex.select('admin_access').from('directus_roles').where('id', '=', key).first();

		if (!role) throw new ForbiddenException();

		// The users that will now be in this new non-admin role
		let userKeys: PrimaryKey[] = [];

		if (Array.isArray(users)) {
			userKeys = users.map((user) => (typeof user === 'string' ? user : user['id'])).filter((id) => id);
		} else {
			userKeys = users.update.map((user) => user['id']).filter((id) => id);
		}

		const usersThatWereInRoleBefore = (await this.knex.select('id').from('directus_users').where('role', '=', key)).map(
			(user) => user.id
		);

		const usersThatAreRemoved = usersThatWereInRoleBefore.filter((id) =>
			Array.isArray(users) ? userKeys.includes(id) === false : users.delete.includes(id) === true
		);

		const usersThatAreAdded = Array.isArray(users) ? users : users.create;

		// If the role the users are moved to is an admin-role, and there's at least 1 (new) admin
		// user, we don't have to check for other admin
		// users
		if ((role.admin_access === true || role.admin_access === 1) && usersThatAreAdded.length > 0) return;

		const otherAdminUsers = await this.knex
			.count('*', { as: 'count' })
			.from('directus_users')
			.whereNotIn('directus_users.id', [...userKeys, ...usersThatAreRemoved])
			.andWhere({ 'directus_roles.admin_access': true })
			.leftJoin('directus_roles', 'directus_users.role', 'directus_roles.id')
			.first();

		const otherAdminUsersCount = +(otherAdminUsers?.count || 0);

		if (otherAdminUsersCount === 0) {
			throw new UnprocessableEntityException(`You can't remove the last admin user from the admin role.`);
		}

		return;
	}

	override async updateOne(key: PrimaryKey, data: Record<string, any>, opts?: MutationOptions): Promise<PrimaryKey> {
		if ('key' in data && data['key'] != null) {
			this.validateKey(data['key']);
		}

		try {
			if ('users' in data) {
				await this.checkForOtherAdminUsers(key, data['users']);
			}
		} catch (err: any) {
			(opts || (opts = {})).preMutationException = err;
		}

		return super.updateOne(key, data, opts);
	}

	override async updateBatch(data: Record<string, any>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		const primaryKeyField = this.schema.collections[this.collection]!.primary;

		for (const item of data) {
			if ('key' in item && item['key'] != null) {
				this.validateKey(item['key']);
				await this.assertKeyUnchanged(item[primaryKeyField], item['key']);
			}
		}

		const keys = data.map((item) => item[primaryKeyField]);
		const setsToNoAdmin = data.some((item) => item['admin_access'] === false);

		try {
			if (setsToNoAdmin) {
				await this.checkForOtherAdminRoles(keys);
			}
		} catch (err: any) {
			(opts || (opts = {})).preMutationException = err;
		}

		return super.updateBatch(data, opts);
	}

	override async updateMany(
		keys: PrimaryKey[],
		data: Record<string, any>,
		opts?: MutationOptions
	): Promise<PrimaryKey[]> {
		if ('key' in data && data['key'] != null) {
			this.validateKey(data['key']);

			for (const id of keys) {
				await this.assertKeyUnchanged(id, data['key']);
			}
		}

		try {
			if ('admin_access' in data && data['admin_access'] === false) {
				await this.checkForOtherAdminRoles(keys);
			}
		} catch (err: any) {
			(opts || (opts = {})).preMutationException = err;
		}

		return super.updateMany(keys, data, opts);
	}

	override async deleteOne(key: PrimaryKey): Promise<PrimaryKey> {
		await this.deleteMany([key]);
		return key;
	}

	override async deleteMany(keys: PrimaryKey[]): Promise<PrimaryKey[]> {
		const opts: MutationOptions = {};

		try {
			await this.checkForOtherAdminRoles(keys);
		} catch (err: any) {
			opts.preMutationException = err;
		}

		await this.knex.transaction(async (trx) => {
			const itemsService = new ItemsService('directus_roles', {
				knex: trx,
				accountability: this.accountability,
				schema: this.schema,
			});

			const permissionsService = new PermissionsService({
				knex: trx,
				accountability: this.accountability,
				schema: this.schema,
			});

			const presetsService = new PresetsService({
				knex: trx,
				accountability: this.accountability,
				schema: this.schema,
			});

			const usersService = new UsersService({
				knex: trx,
				accountability: this.accountability,
				schema: this.schema,
			});

			// Delete permissions/presets for this role, suspend all remaining users in role

			await permissionsService.deleteByQuery(
				{
					filter: { role: { _in: keys } },
				},
				{ ...opts, bypassLimits: true }
			);

			await presetsService.deleteByQuery(
				{
					filter: { role: { _in: keys } },
				},
				{ ...opts, bypassLimits: true }
			);

			await usersService.updateByQuery(
				{
					filter: { role: { _in: keys } },
				},
				{
					status: 'suspended',
					role: null,
				},
				{ ...opts, bypassLimits: true }
			);

			await itemsService.deleteMany(keys, opts);
		});

		return keys;
	}

	override deleteByQuery(query: Query, opts?: MutationOptions): Promise<PrimaryKey[]> {
		return super.deleteByQuery(query, opts);
	}
}
