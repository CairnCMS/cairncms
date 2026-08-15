#!/usr/bin/env node
import { isUpToDate } from '@cairncms/update-check';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
process.env['CAIRNCMS_PACKAGE_VERSION'] = version;

if (process.argv.length === 3 && process.argv[2] === 'start' && version) {
	isUpToDate('cairncms', version)
		.then((latest) => {
			if (latest) {
				// eslint-disable-next-line no-console
				console.warn(`Update available: ${version} -> ${latest}`);
			}
		})
		.catch(() => {});
}

await import('@cairncms/api/cli/run.js');
