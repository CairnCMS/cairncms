export function isSerializationConflict(err: unknown): boolean {
	if (!err || typeof err !== 'object') return false;

	const candidate = err as { code?: unknown; sqlState?: unknown; errno?: unknown };

	const sqlState =
		(typeof candidate.sqlState === 'string' ? candidate.sqlState : undefined) ??
		(typeof candidate.code === 'string' ? candidate.code : undefined);

	if (sqlState === '40001' || sqlState === '40P01') return true;
	if (candidate.errno === 1213) return true;

	return false;
}
