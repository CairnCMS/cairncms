import knex from 'knex';
import { describe, expect, it } from 'vitest';
import { mysql, postgres, sqlite } from './index.js';
import type { AffixComparison } from './types.js';

const OPERAND = 'Team_A!50%';

const COMPARISONS: [string, AffixComparison][] = [
	['starts with', { position: 'start', negate: false }],
	['does not start with', { position: 'start', negate: true }],
	['ends with', { position: 'end', negate: false }],
	['does not end with', { position: 'end', negate: true }],
];

function compile(helper: { caseInsensitiveAffix: postgres['caseInsensitiveAffix'] }, comparison: AffixComparison) {
	const { sql, bindings } = helper.caseInsensitiveAffix('notes.title', OPERAND, comparison).toSQL();
	return { sql, bindings };
}

describe('case-insensitive prefix and suffix comparisons', () => {
	it.each(COMPARISONS)(
		`lowercase both sides under the column's collation on PostgreSQL when the column %s the operand`,
		(_label, comparison) => {
			const helper = new postgres(knex.default({ client: 'pg' }));
			const pattern = comparison.position === 'start' ? 'Team!_A!!50!%%' : '%Team!_A!!50!%';
			const like = comparison.negate ? 'NOT LIKE' : 'LIKE';

			expect(compile(helper, comparison)).toEqual({
				sql: `LOWER(CAST("notes"."title" AS TEXT)) ${like} LOWER(COALESCE(CAST(? AS TEXT), CAST("notes"."title" AS TEXT))) ESCAPE '!'`,
				bindings: [pattern],
			});
		}
	);

	it.each(COMPARISONS)(
		`lowercase both sides under the column's collation on MySQL when the column %s the operand`,
		(_label, comparison) => {
			const helper = new mysql(knex.default({ client: 'mysql2' }));
			const like = comparison.negate ? 'NOT LIKE' : 'LIKE';
			const collatedOperand = "LOWER(CONCAT(?, LEFT(`notes`.`title`, 0))) ESCAPE '!'";

			expect(compile(helper, comparison)).toEqual(
				comparison.position === 'start'
					? { sql: `LOWER(\`notes\`.\`title\`) ${like} ${collatedOperand}`, bindings: ['Team!_A!!50!%%'] }
					: {
							sql: `LOWER(RIGHT(\`notes\`.\`title\`, CHAR_LENGTH(?))) ${like} ${collatedOperand}`,
							bindings: [OPERAND, 'Team!_A!!50!%'],
					  }
			);
		}
	);

	it.each(COMPARISONS)('compare lowercased bytes on SQLite when the column %s the operand', (_label, comparison) => {
		const helper = new sqlite(knex.default({ client: 'sqlite3', useNullAsDefault: true }));

		const slice =
			comparison.position === 'start'
				? 'substr(CAST(LOWER(`notes`.`title`) AS BLOB), 1, length(CAST(LOWER(?) AS BLOB)))'
				: 'substr(CAST(LOWER(`notes`.`title`) AS BLOB), -length(CAST(LOWER(?) AS BLOB)))';

		expect(compile(helper, comparison)).toEqual({
			sql: `${slice} ${comparison.negate ? '<>' : '='} CAST(LOWER(?) AS BLOB)`,
			bindings: [OPERAND, OPERAND],
		});
	});
});
