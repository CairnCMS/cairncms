import { ExtensionSettingsSubjectSchema } from '@cairncms/constants';
import type { Extension, ExtensionCapabilities } from '@cairncms/types';

export const SETTINGS_SUBJECT_INVALID = 'settings-subject-invalid';
export const SETTINGS_SUBJECT_DUPLICATE = 'settings-subject-duplicate';

export type SettingsSubjectReason = { code: string; detail: string };

export type SettingsSubjectStatus = { eligible: true } | { eligible: false; reason: SettingsSubjectReason };

export type ConfinedSettingsCapabilities = {
	self?: ExtensionCapabilities;
	entries?: Record<string, ExtensionCapabilities>;
};

export type ConfinedCapabilitiesLookup = (extension: Extension) => ConfinedSettingsCapabilities | undefined;

function ownsSettings(extension: Extension, capabilities: ConfinedSettingsCapabilities | undefined): boolean {
	if (extension.settings !== undefined) return true;
	if (capabilities?.self?.settings !== undefined) return true;

	if (capabilities?.entries && Object.values(capabilities.entries).some((entry) => entry.settings !== undefined)) {
		return true;
	}

	return false;
}

export function resolveSettingsSubjects(
	extensions: Extension[],
	confinedCapabilities: ConfinedCapabilitiesLookup
): Map<Extension, SettingsSubjectStatus> {
	const owners = extensions.filter((extension) => ownsSettings(extension, confinedCapabilities(extension)));

	const ownerCountBySubject = new Map<string, number>();

	for (const owner of owners) {
		ownerCountBySubject.set(owner.name, (ownerCountBySubject.get(owner.name) ?? 0) + 1);
	}

	const statuses = new Map<Extension, SettingsSubjectStatus>();

	for (const owner of owners) {
		if (ExtensionSettingsSubjectSchema.safeParse(owner.name).success === false) {
			statuses.set(owner, {
				eligible: false,
				reason: {
					code: SETTINGS_SUBJECT_INVALID,
					detail: `the settings subject "${owner.name}" is not a valid extension package name`,
				},
			});

			continue;
		}

		if ((ownerCountBySubject.get(owner.name) ?? 0) > 1) {
			statuses.set(owner, {
				eligible: false,
				reason: {
					code: SETTINGS_SUBJECT_DUPLICATE,
					detail: `the settings subject "${owner.name}" is declared by more than one extension`,
				},
			});

			continue;
		}

		statuses.set(owner, { eligible: true });
	}

	return statuses;
}
