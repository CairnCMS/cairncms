#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);

const exporting =
	args.includes('mysqldump') ||
	args.includes('mariadb-dump') ||
	args.some((arg) => arg.includes('ALLOW_CONNECTIONS false'));

const importing =
	process.env.CONTROL_MODE === 'import-cancel' &&
	args.includes('psql') &&
	args.some((arg) => /TEMPLATE "test_template_/.test(arg));

const hold = (['capture-cancel', 'creator-crash'].includes(process.env.CONTROL_MODE) && exporting) || importing;
const child = spawn(process.env.CONTROL_DOCKER, args, { stdio: ['inherit', hold ? 'pipe' : 'inherit', 'inherit'] });
let marked = false;
let stopping = false;

for (const signal of ['SIGINT', 'SIGTERM'])
	process.once(signal, () => {
		stopping = true;
		if (child.exitCode !== null || child.signalCode !== null) process.exit(signal === 'SIGINT' ? 130 : 143);
		child.kill(signal);

		setTimeout(() => {
			child.kill('SIGKILL');
			process.exit(1);
		}, 5000).unref();
	});

if (hold)
	child.stdout.on('data', (chunk) => {
		if (!marked) {
			process.stdout.write(chunk);
			marked = true;

			writeFileSync(
				join(process.env.CONTROL_DIRECTORY, importing ? 'import-active.json' : 'capture-active.json'),
				JSON.stringify({ pid: process.pid, child: child.pid })
			);
		}
	});
child.once('error', () => process.exit(1));

child.once('exit', (code) => {
	if (!hold || !marked || stopping) process.exit(code ?? 1);
	// Hold the export stream open after real data arrived, until the control interrupts its owner.
	setInterval(() => {}, 1000);
});
