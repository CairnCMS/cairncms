export function detectMachineOutput(args: string[]): boolean {
	const requestedCommand = args.find((arg) => !arg.startsWith('-'));
	if (requestedCommand !== 'config') return false;

	return args.some((arg, index) => (arg === '--format' && args[index + 1] === 'json') || arg === '--format=json');
}

export function applyMachineOutput(args: string[] = process.argv.slice(2)): void {
	if (detectMachineOutput(args)) {
		process.env['CAIRNCMS_LOG_DESTINATION_FD'] = '2';
	}
}

applyMachineOutput();
