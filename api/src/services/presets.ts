import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import type { AbstractServiceOptions, Item, MutationOptions, PrimaryKey } from '../types/index.js';
import { ItemsService } from './items.js';

export class PresetsService extends ItemsService {
	constructor(options: AbstractServiceOptions) {
		super('directus_presets', options);
	}

	private validatePresetOwnership(data: Partial<Item>, options: { requireUser?: boolean } = {}): void {
		if (this.accountability?.admin === true) return;

		const hasUser = 'user' in data;

		if (options.requireUser && !hasUser) {
			throw new InvalidPayloadException('"user" is required on preset creation');
		}

		if (!hasUser) return;

		const callerUser = this.accountability?.user ?? null;
		const requestedUser = (data['user'] as string | null | undefined) ?? null;

		if (callerUser === null) {
			throw new ForbiddenException();
		}

		if (requestedUser !== callerUser) {
			throw new ForbiddenException();
		}
	}

	override async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		this.validatePresetOwnership(data, { requireUser: true });
		return super.createOne(data, opts);
	}

	override async createMany(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		for (const item of data) {
			this.validatePresetOwnership(item, { requireUser: true });
		}

		return super.createMany(data, opts);
	}

	override async updateOne(key: PrimaryKey, data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		this.validatePresetOwnership(data);
		return super.updateOne(key, data, opts);
	}

	override async updateMany(keys: PrimaryKey[], data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		this.validatePresetOwnership(data);
		return super.updateMany(keys, data, opts);
	}

	override async updateBatch(data: Partial<Item>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		for (const item of data) {
			this.validatePresetOwnership(item);
		}

		return super.updateBatch(data, opts);
	}
}
