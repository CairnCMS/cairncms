import { ExtensionSecretPointerSchema } from '@cairncms/constants';
import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import getDatabase from '../database/index.js';
import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { getExtensionManager } from '../extensions.js';
import type { AbstractServiceOptions } from '../types/index.js';

const TABLE = 'cairncms_extension_settings';

type SettingsScope = 'global' | 'collection';

export type StoredSetting = {
	scope: string;
	scope_key: string;
	key: string;
	value: unknown;
};

export class ExtensionSettingsService {
	knex: Knex;
	accountability: Accountability | null;
	schema: SchemaOverview;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.schema = options.schema;
	}

	async set(subject: string, scope: SettingsScope, scopeKey: string, key: string, value: unknown): Promise<void> {
		this.requireAdmin();

		const owner = getExtensionManager().getSettingsOwner(subject);
		if (owner === undefined) throw new ForbiddenException();

		const declared = owner.settings?.[key];
		if (declared === undefined) throw new InvalidPayloadException(`The setting key "${key}" is not declared.`);

		this.validateScope(scope, scopeKey);

		if (scope !== declared.scope) {
			throw new InvalidPayloadException(`The setting key "${key}" is declared at "${declared.scope}" scope.`);
		}

		this.validateValue(declared, value);

		const serialized = JSON.stringify(value);

		await this.knex(TABLE)
			.insert({ id: uuid(), extension: subject, scope, scope_key: scopeKey, key, value: serialized })
			.onConflict(['extension', 'scope', 'scope_key', 'key'])
			.merge({ value: serialized });
	}

	async get(subject: string, scope?: SettingsScope, scopeKey?: string): Promise<StoredSetting[]> {
		this.requireAdmin();

		const query = this.knex(TABLE).where({ extension: subject });
		if (scope !== undefined) query.where({ scope });
		if (scopeKey !== undefined) query.where({ scope_key: scopeKey });

		const rows = await query.select('scope', 'scope_key', 'key', 'value');

		return rows.map((row) => ({
			scope: row.scope,
			scope_key: row.scope_key,
			key: row.key,
			value: JSON.parse(row.value),
		}));
	}

	async deleteBySubject(subject: string): Promise<number> {
		this.requireAdmin();
		return await this.knex(TABLE).where({ extension: subject }).delete();
	}

	private requireAdmin(): void {
		if (this.accountability?.admin !== true) throw new ForbiddenException();
	}

	private validateScope(scope: SettingsScope, scopeKey: string): void {
		if (scope !== 'global' && scope !== 'collection') {
			throw new InvalidPayloadException(`The setting scope must be "global" or "collection".`);
		}

		if (scope === 'global' && scopeKey !== '') {
			throw new InvalidPayloadException(`A global setting must use an empty scope key.`);
		}

		if (
			scope === 'collection' &&
			(scopeKey === '' || Object.prototype.hasOwnProperty.call(this.schema.collections, scopeKey) === false)
		) {
			throw new InvalidPayloadException(`A collection setting must target an existing collection.`);
		}
	}

	private validateValue(declared: { type: string; sensitive?: boolean | undefined }, value: unknown): void {
		if (declared.sensitive === true) {
			if (ExtensionSecretPointerSchema.safeParse(value).success === false) {
				throw new InvalidPayloadException(`A sensitive setting must be stored as a secret pointer.`);
			}

			return;
		}

		if (typeof value !== declared.type) {
			throw new InvalidPayloadException(`The setting value does not match the declared type.`);
		}

		if (declared.type === 'number' && Number.isFinite(value) === false) {
			throw new InvalidPayloadException(`A number setting must be a finite number.`);
		}
	}
}
