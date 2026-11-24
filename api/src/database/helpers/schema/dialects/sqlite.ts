import type { Knex } from 'knex';
import { SchemaHelper, type AffixComparison } from '../types.js';

export class SchemaHelperSQLite extends SchemaHelper {
	/**
	 * Compares the lowercased column and operand as bytes, because SQLite's `LIKE` stops at the first NUL character.
	 * The column is cut to the operand's byte length from the start or the end.
	 */
	override caseInsensitiveAffix(column: Knex.Raw | string, operand: string, comparison: AffixComparison): Knex.Raw {
		const length = 'length(CAST(LOWER(?) AS BLOB))';

		const slice =
			comparison.position === 'start'
				? `substr(CAST(LOWER(??) AS BLOB), 1, ${length})`
				: `substr(CAST(LOWER(??) AS BLOB), -${length})`;

		return this.knex.raw(`${slice} ${comparison.negate ? '<>' : '='} CAST(LOWER(?) AS BLOB)`, [
			column,
			operand,
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
