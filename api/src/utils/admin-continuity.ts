export function leavesAtLeastOneAdmin<Id>(input: {
	currentAdmins: ReadonlySet<Id>;
	removing: ReadonlySet<Id>;
	adding: ReadonlySet<Id>;
}): boolean {
	if (input.adding.size > 0) return true;

	for (const id of input.currentAdmins) {
		if (!input.removing.has(id)) return true;
	}

	return false;
}
