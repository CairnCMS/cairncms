/* eslint-disable no-console */
import type { TestContext } from 'vitest';

declare module 'vitest' {
	export interface TaskMeta {
		integrationBlockedBy?: string;
		integrationSetupFailure?: boolean;
	}
}

export type Prerequisite<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown; reported: boolean; reportedBy?: string };

export async function capturePrerequisite<T>(
	setup: (use: (value: T) => Promise<void>) => Promise<void>,
	use: (result: Prerequisite<T>) => Promise<void>,
	teardownFailures?: unknown[]
) {
	let supplied = false;

	try {
		await setup(async (value) => {
			supplied = true;
			await use({ ok: true, value });
		});
	} catch (error) {
		if (supplied) {
			if (!teardownFailures) throw error;
			// Vitest 3 stops later fixture cleanup at the first thrown error. Report
			// teardown failures after every owned resource has had its finally block.
			console.error('Fixture teardown failure:', error);
			teardownFailures.push(error);
			return;
		}

		await use({ ok: false, error, reported: false });
	}
}

export function requirePrerequisite<T>(
	state: Prerequisite<T>,
	name: string,
	context: Pick<TestContext, 'task' | 'skip'>
): T {
	if (state.ok) return state.value;
	context.task.meta.integrationBlockedBy = name;

	// Native afterEach can resolve the same automatic fixture again. The owning
	// case must keep its error instead of becoming a skip on that second access.
	if (!state.reported || state.reportedBy === context.task.id) {
		state.reported = true;
		state.reportedBy = context.task.id;
		context.task.meta.integrationSetupFailure = true;
		throw state.error;
	}

	context.skip(`Blocked by failed ${name}; see the owning setup failure`);
}
