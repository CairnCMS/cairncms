import fse from 'fs-extra';
import path from 'path';

// The confined engine identity contract requires a contribution's config id to equal
// its name, so the scaffold writes the resolved name into every source file in the
// directory that still carries the placeholder.
export default async function applyExtensionName(sourceDir: string, name: string): Promise<void> {
	for (const file of await fse.readdir(sourceDir)) {
		const filePath = path.join(sourceDir, file);

		if (!(await fse.stat(filePath)).isFile()) continue;

		const content = await fse.readFile(filePath, 'utf8');

		if (content.includes('__extension_name__')) {
			await fse.writeFile(filePath, content.replaceAll('__extension_name__', name));
		}
	}
}
