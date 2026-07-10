import { ExtensionSettingsSubjectSchema, getExtensionConfigSecretName } from '@cairncms/constants';
import type { Extension } from '@cairncms/types';
import { safeLogFragment } from '../utils/safe-log-fragment.js';

export const SETTINGS_SUBJECT_INVALID = 'SETTINGS_SUBJECT_INVALID';
export const SETTINGS_SUBJECT_DUPLICATE = 'SETTINGS_SUBJECT_DUPLICATE';
export const SETTINGS_SUBJECT_CONFIG_COLLISION = 'SETTINGS_SUBJECT_CONFIG_COLLISION';

export type SettingsSubjectReason = { code: string; detail: string };

// `reason` is the public diagnostic (the diagnostics field and the owners endpoint publish
// it), so it never carries a derived config variable. `logDetail`, when present, is the
// variable-bearing line for the load-time log only, the deployment admin's channel.
export type SettingsSubjectStatus =
	| { eligible: true }
	| { eligible: false; reason: SettingsSubjectReason; logDetail?: string };

function ownsSettings(extension: Extension): boolean {
	return extension.settings !== undefined;
}

function configSecretKeys(extension: Extension): string[] {
	return Object.entries(extension.settings ?? {})
		.filter(([, decl]) => decl.secret?.source === 'config')
		.map(([key]) => key);
}

/**
 * Renders an extension name safe for a log line or operator message. A name reaching the
 * invalid-subject path failed validation, so it is untrusted and may carry control
 * characters or newlines.
 */
export function safeExtensionName(name: string): string {
	return safeLogFragment(name);
}

export function resolveSettingsSubjects(extensions: Extension[]): Map<Extension, SettingsSubjectStatus> {
	const owners = extensions.filter((extension) => ownsSettings(extension));

	const ownerCountBySubject = new Map<string, number>();

	for (const owner of owners) {
		ownerCountBySubject.set(owner.name, (ownerCountBySubject.get(owner.name) ?? 0) + 1);
	}

	// A config-sourced secret reads from CAIRNCMS_EXT_<subject>_<key>, both parts sanitized
	// for an env var. Sanitization is lossy, so two package names can normalize to one
	// variable, and two keys of one owner can too. A variable derived more than once would be
	// read as more than one secret, so every owner of a repeated variable is failed closed.
	const derivationsByVariable = new Map<string, { subject: string; key: string }[]>();

	for (const owner of owners) {
		if (ExtensionSettingsSubjectSchema.safeParse(owner.name).success === false) continue;
		if ((ownerCountBySubject.get(owner.name) ?? 0) > 1) continue;

		for (const key of configSecretKeys(owner)) {
			const variable = getExtensionConfigSecretName(owner.name, key);
			const derivations = derivationsByVariable.get(variable) ?? [];
			derivations.push({ subject: owner.name, key });
			derivationsByVariable.set(variable, derivations);
		}
	}

	const collisionsBySubject = new Map<string, { variables: Set<string>; others: Set<string>; keys: Set<string> }>();

	for (const [variable, derivations] of derivationsByVariable) {
		if (derivations.length <= 1) continue;

		for (const { subject, key } of derivations) {
			const collision = collisionsBySubject.get(subject) ?? {
				variables: new Set<string>(),
				others: new Set<string>(),
				keys: new Set<string>(),
			};

			collision.variables.add(variable);

			for (const other of derivations) {
				if (other.subject !== subject) {
					collision.others.add(other.subject);
				} else if (other.key !== key) {
					collision.keys.add(key);
					collision.keys.add(other.key);
				}
			}

			collisionsBySubject.set(subject, collision);
		}
	}

	const statuses = new Map<Extension, SettingsSubjectStatus>();

	for (const owner of owners) {
		if (ExtensionSettingsSubjectSchema.safeParse(owner.name).success === false) {
			statuses.set(owner, {
				eligible: false,
				reason: {
					code: SETTINGS_SUBJECT_INVALID,
					detail: `the settings subject "${safeExtensionName(owner.name)}" is not a valid extension package name`,
				},
			});

			continue;
		}

		if ((ownerCountBySubject.get(owner.name) ?? 0) > 1) {
			statuses.set(owner, {
				eligible: false,
				reason: {
					code: SETTINGS_SUBJECT_DUPLICATE,
					detail: `the settings subject "${safeExtensionName(owner.name)}" is declared by more than one extension`,
				},
			});

			continue;
		}

		const collision = collisionsBySubject.get(owner.name);

		if (collision !== undefined) {
			const name = safeExtensionName(owner.name);
			const variables = [...collision.variables].join(', ');

			if (collision.others.size > 0) {
				const others = [...collision.others].map((other) => `"${safeExtensionName(other)}"`).join(', ');

				statuses.set(owner, {
					eligible: false,
					reason: {
						code: SETTINGS_SUBJECT_CONFIG_COLLISION,
						detail: `the settings subject "${name}" derives a config-secret variable that collides with ${others}`,
					},
					logDetail: `config-secret variable ${variables} for "${name}" collides with ${others}`,
				});

				continue;
			}

			const keys = [...collision.keys].map((key) => `"${safeLogFragment(key)}"`).join(', ');

			statuses.set(owner, {
				eligible: false,
				reason: {
					code: SETTINGS_SUBJECT_CONFIG_COLLISION,
					detail: `the settings subject "${name}" derives one config-secret variable from more than one of its keys (${keys})`,
				},
				logDetail: `config-secret variable ${variables} for "${name}" derives from keys ${keys}`,
			});

			continue;
		}

		statuses.set(owner, { eligible: true });
	}

	return statuses;
}
