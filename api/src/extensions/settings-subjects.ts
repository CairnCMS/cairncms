import { ExtensionSettingsSubjectSchema, getExtensionConfigSecretName } from '@cairncms/constants';
import type { Extension } from '@cairncms/types';

export const SETTINGS_SUBJECT_INVALID = 'settings-subject-invalid';
export const SETTINGS_SUBJECT_DUPLICATE = 'settings-subject-duplicate';
export const SETTINGS_SUBJECT_CONFIG_COLLISION = 'settings-subject-config-collision';

export type SettingsSubjectReason = { code: string; detail: string };

export type SettingsSubjectStatus = { eligible: true } | { eligible: false; reason: SettingsSubjectReason };

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
	const sanitized = Array.from(name, (char) => {
		const code = char.charCodeAt(0);
		return code < 0x20 || (code >= 0x7f && code <= 0x9f) ? '?' : char;
	}).join('');

	return sanitized.length > 64 ? `${sanitized.slice(0, 64)}...` : sanitized;
}

export function resolveSettingsSubjects(extensions: Extension[]): Map<Extension, SettingsSubjectStatus> {
	const owners = extensions.filter((extension) => ownsSettings(extension));

	const ownerCountBySubject = new Map<string, number>();

	for (const owner of owners) {
		ownerCountBySubject.set(owner.name, (ownerCountBySubject.get(owner.name) ?? 0) + 1);
	}

	// A config-sourced secret reads from CAIRNCMS_EXT_<subject>_<KEY>, where <subject> is the
	// package name sanitized for an env var. Sanitization is lossy, so two distinct package
	// names can normalize to one namespace and, sharing a key, one full variable that each
	// would read as the other's secret. Collect the config variables across the valid, unique
	// owners and fail both owners of any shared variable closed. Different keys derive
	// different variables and do not collide.
	const subjectsByVariable = new Map<string, Set<string>>();

	for (const owner of owners) {
		if (ExtensionSettingsSubjectSchema.safeParse(owner.name).success === false) continue;
		if ((ownerCountBySubject.get(owner.name) ?? 0) > 1) continue;

		for (const key of configSecretKeys(owner)) {
			const variable = getExtensionConfigSecretName(owner.name, key);
			const subjects = subjectsByVariable.get(variable) ?? new Set<string>();
			subjects.add(owner.name);
			subjectsByVariable.set(variable, subjects);
		}
	}

	const collisionsBySubject = new Map<string, { variables: Set<string>; others: Set<string> }>();

	for (const [variable, subjects] of subjectsByVariable) {
		if (subjects.size <= 1) continue;

		for (const subject of subjects) {
			const collision = collisionsBySubject.get(subject) ?? { variables: new Set(), others: new Set() };
			collision.variables.add(variable);

			for (const other of subjects) {
				if (other !== subject) collision.others.add(other);
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
			const variables = [...collision.variables].join(', ');
			const others = [...collision.others].map((other) => `"${safeExtensionName(other)}"`).join(', ');

			statuses.set(owner, {
				eligible: false,
				reason: {
					code: SETTINGS_SUBJECT_CONFIG_COLLISION,
					detail: `config-secret variable ${variables} for "${safeExtensionName(owner.name)}" collides with ${others}`,
				},
			});

			continue;
		}

		statuses.set(owner, { eligible: true });
	}

	return statuses;
}
