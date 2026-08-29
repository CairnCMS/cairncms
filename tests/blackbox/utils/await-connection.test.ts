import { spawn, type ChildProcess } from 'child_process';
import { awaitDirectusConnection } from './await-connection';

const DEAD_PORT = 58500;

function onceExit(child: ChildProcess): Promise<void> {
	return new Promise((resolve) => child.once('exit', () => resolve()));
}

describe('awaitDirectusConnection child awareness', () => {
	it('rejects when the child already exited before the wait starts', async () => {
		const child = spawn('node', ['-e', `process.stderr.write('boot failure marker'); process.exit(7);`]);
		await onceExit(child);

		await expect(awaitDirectusConnection(DEAD_PORT, child)).rejects.toThrow(/exited before opening port .*code=7/);
	});

	it('rejects with the captured output when the child exits during the wait', async () => {
		const child = spawn('node', [
			'-e',
			`setTimeout(() => { process.stderr.write('late failure'); process.exit(4); }, 500);`,
		]);

		let message = '';

		try {
			await awaitDirectusConnection(DEAD_PORT, child);
		} catch (error) {
			message = (error as Error).message;
		}

		expect(message).toMatch(/exited before opening port .*code=4/);
		expect(message).toContain('late failure');
	});
});
