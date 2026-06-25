import { ExtensionSecretPointerSchema } from '@cairncms/constants';
import type { Accountability, SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { v4 as uuid } from 'uuid';
import getDatabase from '../database/index.js';
import { ForbiddenException, InvalidPayloadException } from '../exceptions/index.js';
import { getExtensionManager } from '../extensions.js';
import type { AbstractServiceOptions } from '../types/index.js';
import { readCollectionSettings, readGlobalSettings, type StoredSettingRow } from './extension-settings-store.js';

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

	async readForApp(subject: string, collection?: string): Promise<Record<string, unknown>> {
		this.requireAppAccess();

		const declared = getExtensionManager().getSettingsOwner(subject)?.settings;
		if (declared === undefined) return {};

		const result: Record<string, unknown> = {};

		const globalRows = await readGlobalSettings(this.knex, subject);
		this.collectAppReadable(result, declared, 'global', globalRows);

		if (collection !== undefined && this.canReadCollection(collection)) {
			const collectionRows = await readCollectionSettings(this.knex, subject, collection);
			this.collectAppReadable(result, declared, 'collection', collectionRows);
		}

		return result;
	}

	private requireAdmin(): void {
		if (this.accountability?.admin !== true) throw new ForbiddenException();
	}

	private requireAppAccess(): void {
		if (!this.accountability?.user || this.accountability?.app !== true) throw new ForbiddenException();
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

	private collectAppReadable(
		result: Record<string, unknown>,
		declared: Record<
			string,
			{ type: string; scope: string; sensitive?: boolean | undefined; appReadable?: boolean | undefined }
		>,
		scope: SettingsScope,
		rows: StoredSettingRow[]
	): void {
		for (const row of rows) {
			const declaration = declared[row.key];
			if (declaration === undefined) continue;
			if (declaration.scope !== scope) continue;
			if (declaration.sensitive === true) continue;
			if (declaration.appReadable !== true) continue;
			if (this.matchesAppValue(declaration, row.value) === false) continue;

			result[row.key] = row.value;
		}
	}

	private canReadCollection(collection: string): boolean {
		if (Object.prototype.hasOwnProperty.call(this.schema.collections, collection) === false) return false;
		if (this.accountability?.admin === true) return true;

		const permissions = this.accountability?.permissions;
		if (!permissions) return false;

		return permissions.some((permission) => permission.action === 'read' && permission.collection === collection);
	}

	private matchesAppValue(declared: { type: string }, value: unknown): boolean {
		if (typeof value !== declared.type) return false;
		if (declared.type === 'number' && Number.isFinite(value) === false) return false;

		return true;
	}
}
