import chalk from 'chalk';
import { createServer } from 'node:net';

export interface CheckPortsOptions {
	port: number;
}

export default async function checkPorts({ port }: CheckPortsOptions): Promise<void> {
	const available = await isPortAvailable(port);

	if (!available) {
		process.stdout.write(`\n${chalk.red(`✖ Error: port ${port} is already in use on the host.`)}\n\n`);

		process.stdout.write(
			`Either stop the conflicting process, or change ${chalk.cyan('CAIRNCMS_PORT')} in cairncms/.env\n`
		);

		process.stdout.write(`and re-run ${chalk.cyan('npm start')}.\n\n`);
		process.exit(1);
	}
}

function isPortAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();

		server.once('error', () => resolve(false));
		server.once('listening', () => {
			server.close(() => resolve(true));
		});

		server.listen(port, '0.0.0.0');
	});
}
