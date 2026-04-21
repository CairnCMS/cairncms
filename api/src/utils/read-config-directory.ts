import { load as loadYaml } from 'js-yaml';
import { promises as fs } from 'fs';
import path from 'path';
import logger from '../logger.js';
import type { ConfigManifest, ConfigPermissionSet, ConfigRole, CairnConfig } from '../types/config.js';

const ENV_VAR_PATTERN = /^\{\{([A-Z_][A-Z0-9_]*)\}\}$/;

function interpolateEnvVar(value: string, field: string): string {
	const match = value.match(ENV_VAR_PATTERN);
	if (!match) return value;

	const varName = match[1]!;
	const resolved = process.env[varName];

	if (resolved === undefined) {
		logger.warn(`Unresolved env var {{${varName}}} in field "${field}" — leaving as literal.`);
		return value;
	}

	return resolved;
}

function interpolateRole(role: ConfigRole): ConfigRole {
	const result = { ...role };

	if (typeof result.name === 'string') {
		result.name = interpolateEnvVar(result.name, 'name');
	}

	if (typeof result.description === 'string') {
		result.description = interpolateEnvVar(result.description, 'description');
	}

	return result;
}

export async function readConfigDirectory(configPath: string): Promise<CairnConfig> {
	const manifestPath = path.join(configPath, 'cairncms-config.yaml');

	let manifestRaw: string;

	try {
		manifestRaw = await fs.readFile(manifestPath, 'utf-8');
	} catch {
		throw new Error(`Config manifest not found at ${manifestPath}. Is this a valid config directory?`);
	}

	const manifest = loadYaml(manifestRaw) as ConfigManifest;

	if (!manifest || manifest.version !== 1) {
		throw new Error(`Unsupported config version: ${manifest?.version ?? 'missing'}. This engine supports version 1.`);
	}

	if (!manifest.resources || !Array.isArray(manifest.resources)) {
		throw new Error('Config manifest must declare a "resources" array.');
	}

	const roles: ConfigRole[] = [];
	const permissions: ConfigPermissionSet[] = [];

	if (manifest.resources.includes('roles')) {
		const rolesDir = path.join(configPath, 'roles');

		let entries: string[];

		try {
			entries = await fs.readdir(rolesDir);
		} catch {
			entries = [];
		}

		for (const entry of entries) {
			if (!entry.endsWith('.yaml')) continue;

			const content = await fs.readFile(path.join(rolesDir, entry), 'utf-8');
			const role = loadYaml(content) as ConfigRole;

			if (!role || typeof role !== 'object' || !role.key) {
				throw new Error(`Invalid role file: ${entry} — missing "key" field.`);
			}

			if (role.key === 'public') {
				throw new Error(
					`Role key "public" is reserved for public permissions. Remove roles/public.yaml — ` +
						`public permissions belong in permissions/public.yaml only.`
				);
			}

			const expectedFilename = `${role.key}.yaml`;

			if (entry !== expectedFilename) {
				throw new Error(
					`Role file "${entry}" contains key "${role.key}" — filename must match key ("${expectedFilename}").`
				);
			}

			roles.push(interpolateRole(role));
		}
	}

	if (manifest.resources.includes('permissions')) {
		const permissionsDir = path.join(configPath, 'permissions');

		let entries: string[];

		try {
			entries = await fs.readdir(permissionsDir);
		} catch {
			entries = [];
		}

		for (const entry of entries) {
			if (!entry.endsWith('.yaml')) continue;

			const content = await fs.readFile(path.join(permissionsDir, entry), 'utf-8');
			const permSet = loadYaml(content) as ConfigPermissionSet;

			if (!permSet || typeof permSet !== 'object' || !permSet.role) {
				throw new Error(`Invalid permission file: ${entry} — missing "role" field.`);
			}

			if (!Array.isArray(permSet.permissions)) {
				throw new Error(`Invalid permission file: ${entry} — "permissions" must be an array.`);
			}

			const expectedFilename = `${permSet.role}.yaml`;

			if (entry !== expectedFilename) {
				throw new Error(
					`Permission file "${entry}" contains role "${permSet.role}" — filename must match role ("${expectedFilename}").`
				);
			}

			if (permSet.role !== 'public') {
				const matchingRole = roles.find((r) => r.key === permSet.role);

				if (!matchingRole) {
					throw new Error(
						`Permission file "${entry}" references role "${permSet.role}" which has no matching file in roles/.`
					);
				}
			}

			permissions.push(permSet);
		}
	}

	return { manifest, roles, permissions };
}
