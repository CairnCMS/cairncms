import type { Knex } from 'knex';
import { SchemaHelper, type AffixComparison } from '../types.js';

export class SchemaHelperSQLite extends SchemaHelper {
	override caseInsensitiveAffix(column: Knex.Raw | string, operand: string, comparison: AffixComparison): Knex.Raw {
		// SQLite LIKE stops at embedded NUL bytes.
		const bytes = 'CAST(LOWER(??) AS BLOB)';
		const length = 'length(CAST(LOWER(?) AS BLOB))';
		const slice = comparison.position === 'start' ? `substr(${bytes}, 1, ${length})` : `substr(${bytes}, -${length})`;

		// substr() returns NULL for an empty BLOB.
		return this.knex.raw(`COALESCE(${slice}, ${bytes}) ${comparison.negate ? '<>' : '='} CAST(LOWER(?) AS BLOB)`, [
			column,
			operand,
			column,
			operand,
		]);
	}

	override async preColumnChange(): Promise<boolean> {
		const foreignCheckStatus = (await this.knex.raw('PRAGMA foreign_keys'))[0].foreign_keys === 1;

		if (foreignCheckStatus) {
			await this.knex.raw('PRAGMA foreign_keys = OFF');
		}

		return foreignCheckStatus;
	}

	override async postColumnChange(): Promise<void> {
		await this.knex.raw('PRAGMA foreign_keys = ON');
	}
}
