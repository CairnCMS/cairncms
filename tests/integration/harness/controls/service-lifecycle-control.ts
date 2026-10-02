import { once } from 'node:events';
import type { TestAPI } from '@vitest/runner';
import type { Api } from '../../fixtures/environment';

export function serviceLifecycleControl(test: TestAPI<{ api: Api }>) {
	test('service and API lifetimes remain owned through failure or cancellation', async ({ api, signal }) => {
		if (process.env.CONTROL_SERVICE_MODE === 'late-exit') {
			const exited = once(api.child, 'exit');
			api.child.kill('SIGKILL');
			await exited;
		} else {
			process.stdout.write('SERVICE_EXECUTION_READY\n');
			await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
		}
	}, 60_000);
}
