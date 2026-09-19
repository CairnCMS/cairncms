// Must run before index.js constructs the shared logger.
import './machine-output.js';
import { CommanderError } from 'commander';
import { createCli } from './index.js';

const requestedCommand = process.argv.slice(2).find((arg) => !arg.startsWith('-'));

createCli()
	.then((program) => program.parseAsync(process.argv))
	.catch((err) => {
		if (err instanceof CommanderError) {
			process.exit(err.exitCode === 0 ? 0 : 2);
		}

		// eslint-disable-next-line no-console
		console.error(err);
		process.exit(requestedCommand === 'config' ? 3 : 1);
	});
