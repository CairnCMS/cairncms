import type { Knex } from 'knex';
import { SchemaHelper, literalAffixPattern, type AffixComparison } from '../types.js';

export class SchemaHelperDefault extends SchemaHelper {
	override caseInsensitiveAffix(column: Knex.Raw | string, operand: string, comparison: AffixComparison): Knex.Raw {
		// COALESCE gives the bound pattern the column's collation.
		return this.knex.raw(
			`LOWER(CAST(?? AS TEXT)) ${
				comparison.negate ? 'NOT LIKE' : 'LIKE'
			} LOWER(COALESCE(CAST(? AS TEXT), CAST(?? AS TEXT))) ESCAPE '!'`,
			[column, literalAffixPattern(operand, comparison.position), column]
		);
	}
}
