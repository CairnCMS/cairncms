/** Runs before Commander so remote config commands can skip local initialization. */
export function detectRemoteConfigCommand(args: string[]): boolean {
	const terminator = args.indexOf('--');
	const scope = terminator === -1 ? args : args.slice(0, terminator);

	const positionals = scope.filter((arg) => !arg.startsWith('-'));

	if (positionals[0] !== 'config') return false;
	if (positionals[1] !== 'snapshot' && positionals[1] !== 'apply') return false;

	return scope.some((arg) => arg === '--url' || arg.startsWith('--url='));
}
