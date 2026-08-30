import cron from 'node-cron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpy, flowState } = vi.hoisted(() => ({
	logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), debug: vi.fn(), log: vi.fn() },
	flowState: { flows: [] as Array<Record<string, unknown>> },
}));

vi.mock('./logger.js', () => ({ default: logSpy }));

vi.mock('./env.js', async (importOriginal) => {
	const actual = (await importOriginal()) as { default: Record<string, unknown>; [key: string]: unknown };
	return { ...actual, default: actual.default };
});

vi.mock('./schedule-coordination.js', () => ({
	isCoordinationEnabled: () => false,
	createRunCoordinator: () => ({ shouldRun: async () => true }),
	ScheduleCoordinationError: class ScheduleCoordinationError extends Error {},
}));

vi.mock('./database/index.js', () => ({
	default: () => ({ select: () => ({ from: () => Promise.resolve([]) }) }),
}));

vi.mock('./services/flows.js', () => ({
	FlowsService: class {
		async readByQuery() {
			return flowState.flows;
		}
	},
}));

vi.mock('./utils/get-schema.js', () => ({ getSchema: async () => ({ collections: {}, relations: [] }) }));

vi.mock('./utils/construct-flow-tree.js', () => ({ constructFlowTree: (flow: Record<string, unknown>) => flow }));

import { getFlowManager } from './flows.js';

function scheduleFlow(id: string, cron: string): Record<string, unknown> {
	return { id, name: id, status: 'active', trigger: 'schedule', accountability: null, options: { cron } };
}

beforeEach(() => {
	flowState.flows = [];

	const manager = getFlowManager() as any;
	manager.triggerHandlers = [];
	manager.isLoaded = false;
	logSpy.error.mockClear();
});

afterEach(() => {
	for (const task of cron.getTasks().values()) {
		void task.destroy();
	}
});

describe('FlowManager schedule trigger wiring', () => {
	it('records the valid flow and skips one the scheduler rejects, logging only its identity', async () => {
		flowState.flows = [scheduleFlow('flow-valid', '* * * * *'), scheduleFlow('flow-invalid', 'INVALID-EXPR-MARKER')];

		const manager = getFlowManager() as any;
		await manager.load();

		expect(manager.triggerHandlers).toHaveLength(1);
		expect(manager.triggerHandlers[0].id).toBe('flow-valid');

		const invalidCall = logSpy.error.mock.calls.find(
			([fields]: [{ scheduleId?: string }]) => fields?.scheduleId === 'flow-invalid'
		);

		expect(invalidCall).toBeDefined();
		expect(invalidCall![0]).toEqual({ scheduleId: 'flow-invalid' });
		expect(invalidCall![1]).toBe('Skipping schedule trigger with an invalid cron expression');
		expect(JSON.stringify(invalidCall)).not.toContain('INVALID-EXPR-MARKER');
	});

	it('awaits each schedule job teardown before unload completes', async () => {
		const manager = getFlowManager() as any;

		let resolveStop!: () => void;
		let stopStarted = false;

		manager.triggerHandlers = [
			{
				id: 'flow-valid',
				events: [
					{
						type: 'schedule',
						job: {
							stop: () => {
								stopStarted = true;
								return new Promise<void>((resolve) => {
									resolveStop = resolve;
								});
							},
						},
					},
				],
			},
		];

		let unloadDone = false;

		const unloadPromise = manager.unload().then(() => {
			unloadDone = true;
		});

		await Promise.resolve();

		expect(stopStarted).toBe(true);
		expect(unloadDone).toBe(false);

		resolveStop();
		await unloadPromise;

		expect(unloadDone).toBe(true);
		expect(manager.triggerHandlers).toEqual([]);
	});
});
