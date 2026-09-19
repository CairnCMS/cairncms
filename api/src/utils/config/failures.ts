import type { ConfigFailure } from '../../types/config.js';

export function invalid(message: string): ConfigFailure {
	return { code: 'CONFIG_INVALID', message };
}

export function identityConflict(message: string): ConfigFailure {
	return { code: 'CONFIG_IDENTITY_CONFLICT', message };
}
