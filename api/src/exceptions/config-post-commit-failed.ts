import { BaseException } from '@cairncms/exceptions';

export class ConfigPostCommitFailedException extends BaseException {
	constructor() {
		super(
			'The configuration was committed, but cache invalidation failed afterward. Clear the cache with POST /utils/cache/clear to recover.',
			500,
			'CONFIG_POST_COMMIT_FAILED',
			{
				committed: true,
				phase: 'cache',
			}
		);
	}
}
