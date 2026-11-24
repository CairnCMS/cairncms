import type { Knex } from 'knex';
import { SchemaHelper, literalAffixPattern, type AffixComparison } from '../types.js';

export class SchemaHelperDefault extends SchemaHelper {
	/**
	 * Lowercases both sides under the column's collation. Coalescing the operand with the column gives the operand that
	 * collation while still letting the planner use an index on the lowercased column, and the text cast drops the
	 * padding of a fixed-width column.
	 */
	override caseInsensitiveAffix(column: Knex.Raw | string, operand: string, comparison: AffixComparison): Knex.Raw {
		return this.knex.raw(
			`LOWER(CAST(?? AS TEXT)) ${
				comparison.negate ? 'NOT LIKE' : 'LIKE'
			} LOWER(COALESCE(CAST(? AS TEXT), CAST(?? AS TEXT))) ESCAPE '!'`,
			[column, literalAffixPattern(operand, comparison.position), column]
		);
	}
}
