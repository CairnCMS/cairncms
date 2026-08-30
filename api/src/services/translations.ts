import type { Item, PrimaryKey } from '@cairncms/types';
import getDatabase from '../database/index.js';
import { ItemsService } from './items.js';
import { InvalidPayloadException } from '../exceptions/index.js';
import type { AbstractServiceOptions } from '../types/services.js';
import type { MutationOptions } from '../types/items.js';

export class TranslationsService extends ItemsService {
	constructor(options: AbstractServiceOptions) {
		super('directus_translations', options);

		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.schema = options.schema;
	}

	private async translationKeyExists(key: string, language: string, excludeId?: PrimaryKey) {
		const query = this.knex.select('id').from(this.collection).where({ key, language });

		if (excludeId !== undefined) {
			query.whereNot('id', excludeId);
		}

		const result = await query;
		return result.length > 0;
	}

	override async createOne(data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey> {
		if (await this.translationKeyExists(data['key'], data['language'])) {
			throw new InvalidPayloadException('Duplicate key and language combination.');
		}

		return await super.createOne(data, opts);
	}

	override async updateMany(keys: PrimaryKey[], data: Partial<Item>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		if (keys.length > 1 && 'key' in data && 'language' in data) {
			throw new InvalidPayloadException('Duplicate key and language combination.');
		}

		if ('key' in data || 'language' in data) {
			const items = await this.readMany(keys);

			for (const item of items) {
				const updatedData = { ...item, ...data };

				if (await this.translationKeyExists(updatedData['key'], updatedData['language'], item['id'])) {
					throw new InvalidPayloadException('Duplicate key and language combination.');
				}
			}
		}

		return await super.updateMany(keys, data, opts);
	}
}
