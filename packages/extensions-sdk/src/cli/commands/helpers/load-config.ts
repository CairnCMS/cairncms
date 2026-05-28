import { JAVASCRIPT_FILE_EXTS } from '@cairncms/constants';
import { pathToRelativeUrl } from '@cairncms/utils/node';
import fse from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import type { Config } from '../../types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default async function loadConfig(): Promise<Config> {
	for (const ext of JAVASCRIPT_FILE_EXTS) {
		const fileName = `extension.config.${ext}`;

		if (await fse.pathExists(fileName)) {
			const configFile = await import(pathToRelativeUrl(path.resolve(fileName), __dirname));

			return configFile.default;
		}
	}

	return {};
}
