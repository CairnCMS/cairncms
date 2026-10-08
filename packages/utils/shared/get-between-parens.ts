/**
 * Return the text between the first `(` that encloses at least one character and the next `)`, or `null` when there
 * is none.
 */
export function getBetweenParens(value: string): string | null {
	let open = value.indexOf('(');

	while (open !== -1) {
		const close = value.indexOf(')', open + 1);

		if (close === -1) return null;
		if (close > open + 1) return value.slice(open + 1, close);

		open = value.indexOf('(', open + 1);
	}

	return null;
}
