export function settingsReasonKey(code?: string): string {
	if (code === 'settings-subject-invalid') return 'extension_settings_reason_invalid';
	if (code === 'settings-subject-duplicate') return 'extension_settings_reason_duplicate';
	if (code === 'settings-subject-config-collision') return 'extension_settings_reason_config_collision';
	return 'extension_settings_reason_unknown';
}
