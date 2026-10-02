import { describe, expect, it } from 'vitest';
import { RemoteConfigPlanChange } from './remote-response-schema.js';

describe('RemoteConfigPlanChange folder deletion impact', () => {
	function folderDelete(impact: unknown): unknown {
		return { kind: 'folders', operation: 'delete', identity: { key: 'reports' }, impact };
	}

	it('accepts the known blocker categories', () => {
		const result = RemoteConfigPlanChange.safeParse(
			folderDelete([
				{ blockedBy: 'files' },
				{ blockedBy: 'folders' },
				{ blockedBy: 'storage_default_folder' },
				{ blockedBy: 'options.folder' },
			])
		);

		expect(result.success).toBe(true);
	});

	it('accepts an empty impact array', () => {
		expect(RemoteConfigPlanChange.safeParse(folderDelete([])).success).toBe(true);
	});

	it('rejects an unknown blocker category', () => {
		expect(RemoteConfigPlanChange.safeParse(folderDelete([{ blockedBy: 'everything' }])).success).toBe(false);
	});

	it('rejects an impact payload that is not an array', () => {
		expect(RemoteConfigPlanChange.safeParse(folderDelete({ blockedBy: 'files' })).success).toBe(false);
	});
});
