import { BaseException } from '@cairncms/exceptions';

export type ConfigPostCommitPhase = 'cache' | 'actions' | 'cache_and_actions';

const MESSAGES: Record<ConfigPostCommitPhase, string> = {
	cache:
		'The configuration was committed, but cache invalidation failed afterward. Clear the cache with POST /utils/cache/clear to recover.',
	actions:
		'The configuration was committed, but delivering post-commit events failed afterward. Some hooks or flows bound to these events may not have run. No cache action is required.',
	cache_and_actions:
		'The configuration was committed, but post-commit steps failed afterward. Clear the cache with POST /utils/cache/clear to recover, and note that some hooks or flows bound to post-commit events may not have run.',
};

export class ConfigPostCommitFailedException extends BaseException {
	constructor(phase: ConfigPostCommitPhase) {
		super(MESSAGES[phase], 500, 'CONFIG_POST_COMMIT_FAILED', {
			committed: true,
			phase,
		});
	}
}
