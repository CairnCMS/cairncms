import chalk from 'chalk';
import { execa } from 'execa';

export default async function checkDocker(): Promise<void> {
	try {
		await execa('docker', ['--version'], { stdio: 'pipe' });
	} catch {
		fail('Docker is not installed or not on PATH. Install Docker Desktop or Docker Engine and try again.');
	}

	try {
		await execa('docker', ['compose', 'version'], { stdio: 'pipe' });
	} catch {
		fail(
			'Docker Compose v2 is not available. Legacy `docker-compose` (v1) is not supported. Install the Compose plugin or upgrade Docker.'
		);
	}

	try {
		await execa('docker', ['info'], { stdio: 'pipe' });
	} catch {
		fail('The Docker daemon is not running. Start Docker Desktop or `dockerd` and try again.');
	}
}

function fail(message: string): never {
	process.stdout.write(`\n${chalk.red('Error:')} ${message}\n`);
	process.exit(1);
}
