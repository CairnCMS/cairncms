import { PUBLIC_ROLE_ID, PUBLIC_ROLE_KEY } from '@cairncms/constants';
import type { Query } from '@cairncms/types';
import { normalizeRoleKey } from '@cairncms/utils';
import type { Knex } from 'knex';
import { clearSystemCache } from '../cache.js';
import {
	runInBoundSerializable,
	isBoundSerializable,
	lifecycleContextFor,
	type LifecycleContext,
} from '../database/bound-transaction.js';
import { type MutationGuard, withMutationGuard } from '../database/mutation-guard.js';
import { isSerializationConflict } from '../database/serialization-error.js';
import emitter from '../emitter.js';
import {
	AdminMutationUnverifiedTransactionException,
	ConcurrencyConflictException,
	ForbiddenException,
	InvalidPayloadException,
	UnprocessableEntityException,
} from '../exceptions/index.js';
import type { AbstractServiceOptions, Alterations, Item, MutationOptions, PrimaryKey } from '../types/index.js';
import { leavesAtLeastOneAdmin } from '../utils/admin-continuity.js';
import { validateKeys } from '../utils/validate-keys.js';
import { AuthorizationService } from './authorization.js';
import { ItemsService } from './items.js';
import { PermissionsService } from './permissions.js';
import { PresetsService } from './presets.js';
import { UsersService } from './users.js';

type ContinuityMode = 'enforce' | 'failClosed';

const EMPTY: ReadonlySet<PrimaryKey> = new Set();
const LAST_ADMIN_ROLE_MESSAGE = `You can't delete the last admin role.`;

class AdminContinuityGuard implements MutationGuard {
	private readonly demoted = new Set<PrimaryKey>();

	constructor(private readonly mode: ContinuityMode, private readonly snapshot: ReadonlySet<PrimaryKey>) {}

	async beforeUpdate(effectivePayload: Readonly<Record<string, unknown>>, keys: PrimaryKey[]): Promise<void> {
		if (!('admin_access' in effectivePayload)) return;
		if (effectivePayload['admin_access']) return;

		if (this.mode === 'failClosed') throw new AdminMutationUnverifiedTransactionException();

		for (const key of keys) {
			if (this.snapshot.has(key)) this.demoted.add(key);
		}

		if (!leavesAtLeastOneAdmin({ currentAdmins: this.snapshot, removing: this.demoted, adding: EMPTY })) {
			throw new UnprocessableEntityException(LAST_ADMIN_ROLE_MESSAGE);
		}
	}
}

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

	private static readonly RESERVED_KEYS = new Set([PUBLIC_ROLE_KEY]);

	private static readonly SENTINEL_IMMUTABLE_FIELDS = new Set([
		'admin_access',
		'app_access',
		'enforce_tfa',
		'ip_access',
		'users',
	]);

	private isSentinel(id: PrimaryKey): boolean {
		return id === PUBLIC_ROLE_ID;
	}

	private assertSentinelNotDeleted(keys: PrimaryKey[]): void {
		if (keys.some((k) => this.isSentinel(k))) {
			throw new InvalidPayloadException('The public role is a system-reserved entity and cannot be deleted.');
		}
	}

	private assertSentinelUpdateAllowed(keys: PrimaryKey[], data: Record<string, any>): void {
		if (!keys.some((k) => this.isSentinel(k))) return;

		for (const field of Object.keys(data)) {
			if (RolesService.SENTINEL_IMMUTABLE_FIELDS.has(field)) {
				throw new InvalidPayloadException(
					`Cannot change "${field}" on the public role. Only display-only fields (name, icon, description) can be modified.`
				);
			}
		}
	}

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

	private async assertKeyUnchanged(id: PrimaryKey, newKey: unknown, knex: Knex = this.knex): Promise<void> {
		if (newKey === undefined) return;

		const row = await knex('directus_roles').select('key').where({ id }).first();

		if (row && row.key !== newKey) {
			throw new InvalidPayloadException(
				`Role key cannot be changed after creation. Delete and recreate the role instead.`
			);
		}
	}

	private prepareCreatePayload(item: Partial<Item>, usedKeys: Set<string>): void {
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

	private async assertUpdateInvariants(
		key: PrimaryKey,
		data: Record<string, any>,
		knex: Knex = this.knex
	): Promise<void> {
		this.assertSentinelUpdateAllowed([key], data);

		if ('key' in data && data['key'] != null) {
			if (!this.isSentinel(key)) {
				this.validateKey(data['key']);
			}

			await this.assertKeyUnchanged(key, data['key'], knex);
		}
	}

	private async authorizeDelete(keys: PrimaryKey[]): Promise<void> {
		if (!this.accountability || this.accountability.admin === true) return;

		const primaryKeyField = this.schema.collections[this.collection]!.primary;
		validateKeys(this.schema, this.collection, primaryKeyField, keys);

		const authorizationService = new AuthorizationService({
			accountability: this.accountability,
			schema: this.schema,
			knex: this.knex,
		});

		await authorizationService.checkAccess('delete', this.collection, keys);
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
			this.prepareCreatePayload(item, usedKeys);
		}

		return super.createMany(data, opts);
	}

	private async checkForOtherAdminUsers(
		key: PrimaryKey,
		users: Alterations | Item[],
		knex: Knex = this.knex
	): Promise<void> {
		const role = await knex.select('admin_access').from('directus_roles').where('id', '=', key).first();

		if (!role) throw new ForbiddenException();

		// The users that will now be in this new non-admin role
		let userKeys: PrimaryKey[] = [];

		if (Array.isArray(users)) {
			userKeys = users.map((user) => (typeof user === 'string' ? user : user['id'])).filter((id) => id);
		} else {
			userKeys = users.update.map((user) => user['id']).filter((id) => id);
		}

		const usersThatWereInRoleBefore = (await knex.select('id').from('directus_users').where('role', '=', key)).map(
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

		const otherAdminUsers = await knex
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

	private itemsServiceOn(trx: Knex): ItemsService {
		return new ItemsService('directus_roles', {
			knex: trx,
			accountability: this.accountability,
			schema: this.schema,
		});
	}

	private async readAdminRoleIds(trx: Knex): Promise<Set<PrimaryKey>> {
		const rows = await trx('directus_roles').select('id').where({ admin_access: true });
		return new Set(rows.map((row: { id: PrimaryKey }) => row.id));
	}

	private async withBoundContext<T>(
		opts: MutationOptions,
		clearSystemCacheOnFlush: boolean,
		run: (trx: Knex, mode: ContinuityMode, mutationOpts: MutationOptions) => Promise<T>
	): Promise<T> {
		// Joining a transaction another owner opened: queue our effects into its lifecycle
		// context so that owner flushes them once after the real commit.
		if (isBoundSerializable(this.knex)) {
			const context = lifecycleContextFor(this.knex);
			if (!context) throw new AdminMutationUnverifiedTransactionException();
			return run(this.knex, 'enforce', this.deferInto(context, opts, clearSystemCacheOnFlush));
		}

		if ((this.knex as Knex & { isTransaction?: boolean }).isTransaction) {
			return run(this.knex, 'failClosed', opts);
		}

		try {
			return await runInBoundSerializable(
				this.knex,
				(trx) => run(trx, 'enforce', this.deferInto(lifecycleContextFor(trx)!, opts, clearSystemCacheOnFlush)),
				(context) => this.flushContext(context, opts)
			);
		} catch (err) {
			if (isSerializationConflict(err)) throw new ConcurrencyConflictException();
			throw err;
		}
	}

	private deferInto(
		context: LifecycleContext,
		opts: MutationOptions,
		clearSystemCacheOnFlush: boolean
	): MutationOptions {
		context.responseCacheDirty = true;
		if (clearSystemCacheOnFlush) context.systemCacheDirty = true;

		return {
			...opts,
			autoPurgeCache: false,
			autoPurgeSystemCache: false,
			bypassEmitAction: (params) => context.events.push(params),
		};
	}

	private async flushContext(context: LifecycleContext, opts: MutationOptions): Promise<void> {
		if (context.systemCacheDirty && opts.autoPurgeSystemCache !== false) {
			await clearSystemCache({ autoPurgeCache: opts.autoPurgeCache });
		}

		if (context.responseCacheDirty && this.cache && opts.autoPurgeCache !== false) {
			await this.cache.clear();
		}

		if (opts.emitEvents !== false) {
			for (const event of context.events) {
				if (opts.bypassEmitAction) opts.bypassEmitAction(event);
				else emitter.emitAction(event.event, event.meta, event.context);
			}
		}
	}

	override async updateOne(key: PrimaryKey, data: Record<string, any>, opts?: MutationOptions): Promise<PrimaryKey> {
		this.assertSentinelUpdateAllowed([key], data);

		// Skip reserved-key validation on sentinel: its actual key is 'public',
		// so a read-modify-write payload that includes { key: 'public' } is
		// legitimate. Any attempt to change it to a different value is caught
		// later by assertKeyUnchanged in updateMany.
		if ('key' in data && data['key'] != null && !this.isSentinel(key)) {
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

	override async updateBatch(data: Record<string, any>[], opts: MutationOptions = {}): Promise<PrimaryKey[]> {
		const primaryKeyField = this.schema.collections[this.collection]!.primary;

		for (const item of data) {
			await this.assertUpdateInvariants(item[primaryKeyField], item);
		}

		return this.withBoundContext(opts, false, async (trx, mode, mutationOpts) => {
			const snapshot = await this.readAdminRoleIds(trx);
			const guarded = withMutationGuard(mutationOpts, new AdminContinuityGuard(mode, snapshot));
			return this.itemsServiceOn(trx).updateBatch(data, guarded);
		});
	}

	override async updateMany(
		keys: PrimaryKey[],
		data: Record<string, any>,
		opts: MutationOptions = {}
	): Promise<PrimaryKey[]> {
		this.assertSentinelUpdateAllowed(keys, data);

		if ('key' in data && data['key'] != null) {
			// Skip reserved-key check when the operation targets the sentinel —
			// the sentinel legitimately has key='public'. Any actual key-change
			// attempt is caught by assertKeyUnchanged below.
			if (!keys.some((k) => this.isSentinel(k))) {
				this.validateKey(data['key']);
			}

			for (const id of keys) {
				await this.assertKeyUnchanged(id, data['key']);
			}
		}

		return this.withBoundContext(opts, false, async (trx, mode, mutationOpts) => {
			const snapshot = await this.readAdminRoleIds(trx);
			const guarded = withMutationGuard(mutationOpts, new AdminContinuityGuard(mode, snapshot));
			return this.itemsServiceOn(trx).updateMany(keys, data, guarded);
		});
	}

	override async upsertMany(payloads: Partial<Item>[], opts: MutationOptions = {}): Promise<PrimaryKey[]> {
		const options: MutationOptions = { ...opts };
		if (!options.mutationTracker) options.mutationTracker = this.createMutationTracker();

		const primaryKeyField = this.schema.collections[this.collection]!.primary;

		return this.withBoundContext(options, false, async (trx, mode, mutationOpts) => {
			const snapshot = await this.readAdminRoleIds(trx);
			const guarded = withMutationGuard(mutationOpts, new AdminContinuityGuard(mode, snapshot));
			const service = this.itemsServiceOn(trx);
			const existing = await trx('directus_roles').select('key');
			const usedKeys = new Set(existing.map((row: { key: string }) => row.key));
			const primaryKeys: PrimaryKey[] = [];

			for (const payload of payloads) {
				const primaryKey: PrimaryKey | undefined = payload[primaryKeyField];

				if (primaryKey) {
					validateKeys(this.schema, this.collection, primaryKeyField, primaryKey);
				}

				const exists =
					!!primaryKey &&
					!!(await trx
						.select(primaryKeyField)
						.from(this.collection)
						.where({ [primaryKeyField]: primaryKey })
						.first());

				if (exists) {
					await this.assertUpdateInvariants(primaryKey as PrimaryKey, payload, trx);

					const itemOpts: MutationOptions = { ...guarded };

					try {
						if ('users' in payload) {
							await this.checkForOtherAdminUsers(primaryKey as PrimaryKey, payload['users'], trx);
						}
					} catch (err: any) {
						itemOpts.preMutationException = err;
					}

					primaryKeys.push(await service.updateOne(primaryKey as PrimaryKey, payload, itemOpts));
				} else {
					this.prepareCreatePayload(payload, usedKeys);
					primaryKeys.push(await service.createOne(payload, guarded));
				}
			}

			return primaryKeys;
		});
	}

	override async deleteOne(key: PrimaryKey, opts?: MutationOptions): Promise<PrimaryKey> {
		await this.deleteMany([key], opts);
		return key;
	}

	override async deleteMany(keys: PrimaryKey[], opts: MutationOptions = {}): Promise<PrimaryKey[]> {
		await this.authorizeDelete(keys);
		this.assertSentinelNotDeleted(keys);

		return this.withBoundContext(opts, true, async (trx, mode, mutationOpts) => {
			if (mode === 'failClosed') throw new AdminMutationUnverifiedTransactionException();

			const snapshot = await this.readAdminRoleIds(trx);

			if (!leavesAtLeastOneAdmin({ currentAdmins: snapshot, removing: new Set(keys), adding: EMPTY })) {
				throw new UnprocessableEntityException(LAST_ADMIN_ROLE_MESSAGE);
			}

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

			await permissionsService.deleteByQuery(
				{
					filter: { role: { _in: keys } },
				},
				{ ...mutationOpts, bypassLimits: true }
			);

			await presetsService.deleteByQuery(
				{
					filter: { role: { _in: keys } },
				},
				{ ...mutationOpts, bypassLimits: true }
			);

			await usersService.updateByQuery(
				{
					filter: { role: { _in: keys } },
				},
				{
					status: 'suspended',
					role: null,
				},
				{ ...mutationOpts, bypassLimits: true }
			);

			await this.itemsServiceOn(trx).deleteMany(keys, mutationOpts);

			return keys;
		});
	}

	override deleteByQuery(query: Query, opts?: MutationOptions): Promise<PrimaryKey[]> {
		return super.deleteByQuery(query, opts);
	}
}
