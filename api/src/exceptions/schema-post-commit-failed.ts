import { BaseException } from '@cairncms/exceptions';

export const SCHEMA_POST_COMMIT_PHASES = [
	'cache',
	'actions',
	'cache_and_actions',
	'foreign_keys',
	'foreign_keys_and_cache',
] as const;

export type SchemaPostCommitPhase = (typeof SCHEMA_POST_COMMIT_PHASES)[number];

const MESSAGES: Record<SchemaPostCommitPhase, string> = {
	cache: 'The schema change was committed, but cache invalidation failed afterward.',
	actions: 'The schema change was committed, but post-commit event delivery failed afterward.',
	cache_and_actions:
		'The schema change was committed, but cache invalidation and post-commit event delivery failed afterward.',
	foreign_keys: 'The schema change was committed, but foreign key restoration failed afterward.',
	foreign_keys_and_cache:
		'The schema change was committed, but foreign key restoration and cache invalidation failed afterward.',
};

export class SchemaPostCommitFailedException extends BaseException {
	constructor(phase: SchemaPostCommitPhase) {
		super(MESSAGES[phase], 500, 'SCHEMA_POST_COMMIT_FAILED', {
			committed: true,
			phase,
		});
	}
}
