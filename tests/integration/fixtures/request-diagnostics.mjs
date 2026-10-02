export function requestFailure({ method, path, response, error, problem }) {
	const detail = JSON.stringify({
		method,
		path,
		status: response?.status ?? null,
		problem: problem ?? error?.message ?? 'Request failed',
		assertion: error?.message,
		body: response?.body,
	}).slice(0, 4000);

	return new Error(`HTTP request failed: ${detail}`);
}

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const identity = (value) =>
	typeof value === 'string' ? value.length > 0 : typeof value === 'number' && Number.isFinite(value);

export function setupProblem(method, path, payload, response, query = {}) {
	if (response.status < 200 || response.status >= 300) return 'Expected a successful setup response';
	if (response.status === 204 || method === 'head' || path.split('?')[0] === '/server/ping') return;
	if (response.body?.errors?.length) return 'Setup returned API errors';
	const route = path.split('?')[0].split('/').filter(Boolean);
	if (route[0] === 'schema' && query.export === 'yaml')
		return typeof response.text === 'string' && response.text.trim() ? undefined : 'Schema setup returned no YAML';
	if (
		![
			'items',
			'roles',
			'users',
			'permissions',
			'files',
			'flows',
			'operations',
			'folders',
			'presets',
			'shares',
			'collections',
			'fields',
			'relations',
			'auth',
			'graphql',
			'extensions',
			'schema',
		].includes(route[0])
	)
		return;
	const data = response.body?.data;
	if (!record(data) && !Array.isArray(data)) return 'Setup returned no data object or array';
	const rows = Array.isArray(data) ? data : [data];
	if (!rows.every((row) => record(row) && Object.keys(row).length)) return 'Setup returned malformed data entries';
	if (method === 'post' && record(payload) && rows.length === 0) return 'Setup returned no created records';
	const fields = query.fields === undefined ? null : String(query.fields).split(',');
	const includes = (key) => !fields || fields.includes('*') || fields.includes(key);
	if ((route[0] === 'auth' && route[1] === 'login') || (route[0] === 'shares' && route[1] === 'auth'))
		return identity(data.access_token) ? undefined : 'Login setup returned no access token';
	if (
		['roles', 'users', 'permissions', 'files', 'flows', 'operations', 'folders', 'presets', 'shares'].includes(
			route[0]
		) &&
		includes('id') &&
		!rows.every((row) => identity(row.id))
	)
		return 'Setup returned no record identity';

	if (['collections', 'fields', 'relations'].includes(route[0])) {
		if (includes('collection') && !rows.every((row) => typeof row.collection === 'string' && row.collection))
			return 'Setup returned no collection identity';
		if (
			route[0] !== 'collections' &&
			includes('field') &&
			!rows.every((row) => typeof row.field === 'string' && row.field)
		)
			return 'Setup returned no field identity';

		if (method === 'post' && record(payload) && rows.length === 1) {
			for (const key of ['collection', ...(route[0] === 'collections' ? [] : ['field'])])
				if (includes(key) && payload[key] && rows[0][key] !== payload[key])
					return `Setup returned a different ${key} identity`;
		}
	}
}
