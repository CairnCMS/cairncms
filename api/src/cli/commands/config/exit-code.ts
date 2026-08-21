import { BaseException } from '@cairncms/exceptions';

export function configFailureExitCode(error: unknown): 2 | 3 {
	const members = Array.isArray(error) ? error : [error];

	if (members.length === 0) return 3;

	for (const member of members) {
		if (member instanceof BaseException && member.status >= 400 && member.status < 500) continue;
		return 3;
	}

	return 2;
}
