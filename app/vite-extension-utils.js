import fs from 'node:fs';
import path from 'node:path';

export function getExtensionRealPaths(extensionsPath) {
	if (!fs.existsSync(extensionsPath)) return [];

	const realPaths = [];

	for (const entry of fs.readdirSync(extensionsPath)) {
		let entryReal;

		try {
			entryReal = fs.realpathSync(path.join(extensionsPath, entry));
			if (!fs.statSync(entryReal).isDirectory()) continue;
		} catch {
			continue;
		}

		realPaths.push(entryReal);

		for (const child of fs.readdirSync(entryReal)) {
			try {
				const childReal = fs.realpathSync(path.join(entryReal, child));
				if (fs.statSync(childReal).isDirectory()) realPaths.push(childReal);
			} catch {
				// unreadable child, skip
			}
		}
	}

	return realPaths;
}

export function isUnderExtensions(extensionsRoot, changedPath) {
	const relative = path.relative(extensionsRoot, changedPath);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}
