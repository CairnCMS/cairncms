import type { Knex } from 'knex';
import { getDatabaseVersion } from '../../../../database/index.js';
import { SchemaHelper, escapeLikeLiteral, literalAffixPattern, type AffixComparison } from '../types.js';

export class SchemaHelperMySQL extends SchemaHelper {
	/**
	 * Lowercases both sides under the column's collation. Concatenating an empty slice of the column gives the operand
	 * that collation, which can lowercase a letter differently from the connection's. A suffix is compared with the
	 * column's trailing characters because the Unicode collations of MySQL 5.7 never match a pattern in which `%`
	 * directly precedes an escaped `!`.
	 */
	override caseInsensitiveAffix(column: Knex.Raw | string, operand: string, comparison: AffixComparison): Knex.Raw {
		const like = comparison.negate ? 'NOT LIKE' : 'LIKE';

		if (comparison.position === 'start') {
			return this.knex.raw(`LOWER(??) ${like} LOWER(CONCAT(?, LEFT(??, 0))) ESCAPE '!'`, [
				column,
				literalAffixPattern(operand, 'start'),
				column,
			]);
		}

		return this.knex.raw(`LOWER(RIGHT(??, CHAR_LENGTH(?))) ${like} LOWER(CONCAT(?, LEFT(??, 0))) ESCAPE '!'`, [
			column,
			operand,
			escapeLikeLiteral(operand),
			column,
		]);
	}

	override applyMultiRelationalSort(
		knex: Knex,
		dbQuery: Knex.QueryBuilder,
		table: string,
		primaryKey: string,
		orderByString: string,
		orderByFields: Knex.Raw[]
	): Knex.QueryBuilder {
		if (getDatabaseVersion()?.startsWith('5.7')) {
			// The session-variable rank restarts whenever the key changes, so each item's rows must be adjacent
			dbQuery.clear('order');
			dbQuery.orderByRaw(`?? asc, ${orderByString}`, [`${table}.${primaryKey}`, ...orderByFields]);

			dbQuery = knex
				.select(
					knex.raw(
						`??, ( @rank := IF ( @cur_id = deep.${primaryKey}, @rank + 1, 1 ) ) AS directus_row_number, ( @cur_id := deep.${primaryKey} ) AS current_id`,
						'deep.*'
					)
				)
				.from(knex.raw('? as ??, (SELECT @rank := 0,  @cur_id := null) vars', [dbQuery, 'deep']));

			return dbQuery;
		}

		return super.applyMultiRelationalSort(knex, dbQuery, table, primaryKey, orderByString, orderByFields);
	}
}
