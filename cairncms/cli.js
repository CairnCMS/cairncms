#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(here, 'package.json'), 'utf8'));
process.env['CAIRNCMS_PACKAGE_VERSION'] = version;

await import('@cairncms/api/cli/run.js');
