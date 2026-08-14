import { Knex } from 'knex';
import axios from 'axios';
import { sleep } from './sleep';
import type { ChildProcess } from 'child_process';

const MAX_CAPTURE_CHARS = 16 * 1024;

export async function awaitDatabaseConnection(database: Knex, checkSQL: string): Promise<void | null> {
	for (let attempt = 0; attempt <= 30; attempt++) {
		try {
			await database.raw(checkSQL);
			return null;
		} catch (error) {
			await sleep(5000);
			continue;
		}
	}

	throw new Error(`Couldn't connect to DB`);
}

export async function awaitDirectusConnection(port: number, child?: ChildProcess): Promise<void | null> {
	const state: { death: string | null } = { death: null };
	let captured = '';
	let interruptRetry: (() => void) | undefined;

	const capture = (chunk: unknown) => {
		captured += String(chunk);
		if (captured.length > MAX_CAPTURE_CHARS) captured = captured.slice(-MAX_CAPTURE_CHARS);
	};

	const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
		state.death = `exited before opening port ${port} (code=${code} signal=${signal})`;
		interruptRetry?.();
	};

	const onError = (error: Error) => {
		state.death = `errored before opening port ${port}: ${error.message}`;
		interruptRetry?.();
	};

	if (child) {
		child.on('exit', onExit);
		child.on('error', onError);
		child.stdout?.on('data', capture);
		child.stderr?.on('data', capture);

		if (child.exitCode !== null || child.signalCode !== null) {
			state.death = `exited before opening port ${port} (code=${child.exitCode} signal=${child.signalCode})`;
		}
	}

	try {
		for (let attempt = 0; attempt <= 100; attempt++) {
			if (state.death) {
				throw new Error(`Directus process ${state.death}\n--- captured output (tail) ---\n${captured}`);
			}

			try {
				await axios.get(`http://127.0.0.1:${port}/server/ping`);
				return null;
			} catch {
				if (state.death) continue;

				await new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 5000);

					interruptRetry = () => {
						clearTimeout(timer);
						resolve();
					};
				});

				interruptRetry = undefined;
				continue;
			}
		}

		throw new Error(`Couldn't connect to Directus on port ${port}`);
	} finally {
		if (child) {
			child.off('exit', onExit);
			child.off('error', onError);
			child.stdout?.off('data', capture);
			child.stderr?.off('data', capture);
		}
	}
}
