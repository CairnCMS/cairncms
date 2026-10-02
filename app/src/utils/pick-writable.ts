export function pickWritable(edits: Record<string, any>, fields: string[] | null): Record<string, any> {
	const picked: Record<string, any> = {};
	const all = !!fields && fields.includes('*');

	for (const key of Object.keys(edits)) {
		if (key.startsWith('$')) {
			picked[key] = edits[key];
			continue;
		}

		if (all || (fields && fields.includes(key))) picked[key] = edits[key];
	}

	return picked;
}
