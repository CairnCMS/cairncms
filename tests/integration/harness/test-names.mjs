// Vitest 3's native -t matches suite/test names joined with spaces. ReportedTask.fullName uses a different, display-only ' > '.
// Walk public reported parents so a literal ' > ' inside a title stays intact.
export function nativeTestName(test) {
	const names = [test.name];
	for (let parent = test.parent; parent.type !== 'module'; parent = parent.parent) names.unshift(parent.name);
	return names.join(' ');
}
