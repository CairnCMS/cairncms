import { BaseException } from '@cairncms/exceptions';
import type { ConfigProtection, ProtectionContributor } from '../types/index.js';

type Extensions = {
	protection: { code: ConfigProtection['code'] };
	contributors: ProtectionContributor[];
};

export class ConfigProtectedRecordException extends BaseException<Partial<Extensions>> {
	constructor(message: string, extensions?: Extensions) {
		super(message, 400, 'CONFIG_PROTECTED_RECORD', extensions);
	}
}
