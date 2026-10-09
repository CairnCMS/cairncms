import { getBetweenParens } from './get-between-parens.js';

/**
 * Parse count(a.b.c) as a.b.count(c) and a.b.count(c.d) as a.b.c.count(d)
 */
export function parseFilterFunctionPath(path: string): string {
	if (path.includes('(') && path.includes(')')) {
		const pre = path.split('(')[0]!;
		const preHasColumns = pre.includes('.');
		const preColumns = preHasColumns ? pre.slice(0, pre.lastIndexOf('.') + 1) : '';
		const functionName = preHasColumns ? pre.slice(pre.lastIndexOf('.') + 1) : pre;

		const fields = getBetweenParens(path);

		if (fields !== null) {
			const fieldsHasColumns = fields.includes('.');
			const columns = fieldsHasColumns ? fields.slice(0, fields.lastIndexOf('.') + 1) : '';
			const field = fieldsHasColumns ? fields.slice(fields.lastIndexOf('.') + 1) : fields;

			return `${preColumns}${columns}${functionName}(${field})`;
		}
	}

	return path;
}
