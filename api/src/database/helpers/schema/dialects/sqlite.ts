import type { Knex } from 'knex';
import { SchemaHelper, type AffixComparison } from '../types.js';

export class SchemaHelperSQLite extends SchemaHelper {
	/**
	 * Compares the lowercased column and operand as bytes, because SQLite's `LIKE` stops at the first NUL character.
	 * The column is cut to the operand's byte length from the start or the end. A slice of empty text is SQL `NULL` in
	 * SQLite, so the uncut column stands in for it, which keeps empty text distinct from a `NULL` column.
	 */
	override caseInsensitiveAffix(column: Knex.Raw | string, operand: string, comparison: AffixComparison): Knex.Raw {
		const bytes = 'CAST(LOWER(??) AS BLOB)';
		const length = 'length(CAST(LOWER(?) AS BLOB))';
		const slice = comparison.position === 'start' ? `substr(${bytes}, 1, ${length})` : `substr(${bytes}, -${length})`;

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
