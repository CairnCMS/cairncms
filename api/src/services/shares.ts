import argon2 from 'argon2';
import jwt from 'jsonwebtoken';
import env from '../env.js';
import { ForbiddenException, InvalidCredentialsException, InvalidPayloadException } from '../exceptions/index.js';
import type {
	AbstractServiceOptions,
	CairnTokenPayload,
	Item,
	LoginResult,
	MutationOptions,
	PrimaryKey,
	ShareData,
} from '../types/index.js';
import { getMilliseconds } from '../utils/get-milliseconds.js';
import { md } from '../utils/md.js';
import { Url } from '../utils/url.js';
import { userName } from '../utils/user-name.js';
import { AuthorizationService } from './authorization.js';
import { ItemsService } from './items.js';
import { MailService } from './mail/index.js';
import { UsersService } from './users.js';

export class SharesService extends ItemsService {
	authorizationService: AuthorizationService;

	constructor(options: AbstractServiceOptions) {
		super('directus_shares', options);

		this.authorizationService = new AuthorizationService({
			accountability: this.accountability,
			knex: this.knex,
			schema: this.schema,
		});
	}

	private validateShareRole(data: Partial<Item>, options: { requireRole?: boolean } = {}): void {
		if (this.accountability?.admin === true) return;

		const hasRole = 'role' in data;

		if (options.requireRole && !hasRole) {
			throw new InvalidPayloadException('"role" is required on share creation');
		}

		if (!hasRole) return;

		const callerRole = this.accountability?.role ?? null;
		const requestedRole = (data['role'] as string | null | undefined) ?? null;

		if (callerRole === null) {
			throw new ForbiddenException();
		}

		if (requestedRole !== callerRole) {
			throw new ForbiddenException();
		}
	}

	override async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		this.validateShareRole(data, { requireRole: true });
		await this.authorizationService.checkAccess('share', data['collection'], data['item']);
		return super.createOne(data, opts);
	}

	override async createMany(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		for (const item of data) {
			this.validateShareRole(item, { requireRole: true });
			await this.authorizationService.checkAccess('share', item['collection'], item['item']);
		}

		return super.createMany(data, opts);
	}

	override async updateOne(key: PrimaryKey, data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		this.validateShareRole(data);
		return super.updateOne(key, data, opts);
	}

	override async updateMany(keys: PrimaryKey[], data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		this.validateShareRole(data);
		return super.updateMany(keys, data, opts);
	}

	override async updateBatch(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		for (const item of data) {
			this.validateShareRole(item);
		}

		return super.updateBatch(data, opts);
	}

	async login(payload: Record<string, any>): Promise<LoginResult> {
		const { nanoid } = await import('nanoid');

		const record = await this.knex
			.select<ShareData>({
				share_id: 'id',
				share_role: 'role',
				share_item: 'item',
				share_collection: 'collection',
				share_start: 'date_start',
				share_end: 'date_end',
				share_times_used: 'times_used',
				share_max_uses: 'max_uses',
				share_password: 'password',
			})
			.from('directus_shares')
			.where('id', payload['share'])
			.andWhere((subQuery) => {
				subQuery.whereNull('date_end').orWhere('date_end', '>=', new Date());
			})
			.andWhere((subQuery) => {
				subQuery.whereNull('date_start').orWhere('date_start', '<=', new Date());
			})
			.andWhere((subQuery) => {
				subQuery.whereNull('max_uses').orWhere('max_uses', '>=', this.knex.ref('times_used'));
			})
			.first();

		if (!record) {
			throw new InvalidCredentialsException();
		}

		if (record.share_password && !(await argon2.verify(record.share_password, payload['password']))) {
			throw new InvalidCredentialsException();
		}

		await this.knex('directus_shares')
			.update({ times_used: record.share_times_used + 1 })
			.where('id', record.share_id);

		const tokenPayload: CairnTokenPayload = {
			app_access: false,
			admin_access: false,
			role: record.share_role,
			share: record.share_id,
			share_scope: {
				item: record.share_item,
				collection: record.share_collection,
			},
		};

		const accessToken = jwt.sign(tokenPayload, env['SECRET'] as string, {
			expiresIn: env['ACCESS_TOKEN_TTL'],
			issuer: 'cairncms',
		});

		const refreshToken = nanoid(64);
		const refreshTokenExpiration = new Date(Date.now() + getMilliseconds(env['REFRESH_TOKEN_TTL'], 0));

		await this.knex('directus_sessions').insert({
			token: refreshToken,
			expires: refreshTokenExpiration,
			ip: this.accountability?.ip,
			user_agent: this.accountability?.userAgent,
			origin: this.accountability?.origin,
			share: record.share_id,
		});

		await this.knex('directus_sessions').delete().where('expires', '<', new Date());

		return {
			accessToken,
			refreshToken,
			expires: getMilliseconds(env['ACCESS_TOKEN_TTL']),
		};
	}

	/**
	 * Send a link to the given share ID to the given email(s). Note: you can only send a link to a share
	 * if you have read access to that particular share
	 */
	async invite(payload: { emails: string[]; share: PrimaryKey }) {
		if (!this.accountability?.user) throw new ForbiddenException();

		const share = await this.readOne(payload.share, { fields: ['collection'] });

		const usersService = new UsersService({
			knex: this.knex,
			schema: this.schema,
		});

		const mailService = new MailService({ schema: this.schema, accountability: this.accountability });

		const userInfo = await usersService.readOne(this.accountability.user, {
			fields: ['first_name', 'last_name', 'email', 'id'],
		});

		const message = `
Hello!

${userName(userInfo)} has invited you to view an item in ${share['collection']}.

[Open](${new Url(env['PUBLIC_URL']).addPath('admin', 'shared', payload.share).toString()})
`;

		for (const email of payload.emails) {
			await mailService.send({
				template: {
					name: 'base',
					data: {
						html: md(message),
					},
				},
				to: email,
				subject: `${userName(userInfo)} has shared an item with you`,
			});
		}
	}
}
