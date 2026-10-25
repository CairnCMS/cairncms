/**
 * Collection and field names can both contain dots, so joining them with one would give `a.b` / `c` and `a` / `b.c`
 * the same key.
 */
export function schemaEntityKey(collection: string, field: string): string {
	return JSON.stringify([collection, field]);
}
