import { dump as toYaml } from 'js-yaml';
import { promises as fs } from 'fs';
import path from 'path';
import type { ConfigPermission, ConfigPermissionSet, CairnConfig } from '../types/config.js';

function sortStringArray(arr: string[] | null | undefined): string[] | null {
	if (!arr) return null;
	return [...arr].sort();
}

function sortPermissions(permissions: ConfigPermission[]): ConfigPermission[] {
	return [...permissions]
		.sort((a, b) => {
			const cmp = a.collection.localeCompare(b.collection);
			if (cmp !== 0) return cmp;
			return a.action.localeCompare(b.action);
		})
		.map((p) => ({ ...p, fields: sortStringArray(p.fields) }));
}

function dumpYaml(data: unknown): string {
	return toYaml(data, { indent: 2, sortKeys: true, lineWidth: -1, noRefs: true });
}

async function cleanDirectory(dir: string, keepFiles: Set<string>): Promise<void> {
	let entries: string[];

	try {
		entries = await fs.readdir(dir);
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry.endsWith('.yaml') && !keepFiles.has(entry)) {
			await fs.unlink(path.join(dir, entry));
		}
	}
}

export async function writeConfigDirectory(config: CairnConfig, targetPath: string): Promise<void> {
	const rolesDir = path.join(targetPath, 'roles');
	const permissionsDir = path.join(targetPath, 'permissions');

	await fs.mkdir(rolesDir, { recursive: true });
	await fs.mkdir(permissionsDir, { recursive: true });

	await fs.writeFile(path.join(targetPath, 'cairncms-config.yaml'), dumpYaml(config.manifest));

	const sortedRoles = [...config.roles].sort((a, b) => a.key.localeCompare(b.key));
	const roleFiles = new Set<string>();

	for (const role of sortedRoles) {
		const filename = `${role.key}.yaml`;
		roleFiles.add(filename);

		const normalized = { ...role };
		if (normalized.ip_access) normalized.ip_access = sortStringArray(normalized.ip_access);

		await fs.writeFile(path.join(rolesDir, filename), dumpYaml(normalized));
	}

	const sortedPermSets = [...config.permissions].sort((a, b) => a.role.localeCompare(b.role));
	const permFiles = new Set<string>();

	for (const permSet of sortedPermSets) {
		const filename = `${permSet.role}.yaml`;
		permFiles.add(filename);

		const sorted: ConfigPermissionSet = {
			role: permSet.role,
			permissions: sortPermissions(permSet.permissions),
		};

		await fs.writeFile(path.join(permissionsDir, filename), dumpYaml(sorted));
	}

	await cleanDirectory(rolesDir, roleFiles);
	await cleanDirectory(permissionsDir, permFiles);
}
