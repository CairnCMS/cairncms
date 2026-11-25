import { beforeEach, describe, expect, it, vi } from 'vitest';

const { logSpy, loadState } = vi.hoisted(() => ({
	logSpy: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), debug: vi.fn(), log: vi.fn() },
	loadState: {
		rows: [] as Array<Record<string, unknown>>,
		flows: [] as Array<Record<string, unknown>>,
	},
}));

vi.mock('./logger.js', () => ({ default: logSpy }));

vi.mock('./database/index.js', () => ({
	default: () => ({ select: () => ({ from: () => Promise.resolve(loadState.rows) }) }),
}));

vi.mock('./services/flows.js', () => ({
	FlowsService: class {
		async readByQuery() {
			return structuredClone(loadState.flows);
		}
	},
}));

vi.mock('./utils/get-schema.js', () => ({ getSchema: async () => ({ collections: {}, relations: [] }) }));

import { getFlowManager } from './flows.js';

// SQLite returns options as text. After sanitization, both fixtures have the same empty query.
const VALID = '{"key": [5], "payload": {"paid": true}, "query": {}}';
const CONFLICT = '{"key": [5], "payload": {"paid": true}, "query": {"__proto__": {"filter": {}}}}';

function storeFlow(updateColumn: string) {
	loadState.rows = [
		{ id: 'op-gate', type: 'gate', options: '{}' },
		{ id: 'op-update', type: 'item-update', options: updateColumn },
		{ id: 'op-capture', type: 'capture', options: '{}' },
	];

	loadState.flows = [
		{
			id: 'targets-flow',
			name: 'targets-flow',
			status: 'active',
			trigger: 'operation',
			accountability: null,
			options: {},
			operation: 'op-gate',
			operations: [
				{
					id: 'op-gate',
					key: 'gate',
					type: 'gate',
					options: {},
					resolve: 'op-update',
					reject: null,
					flow: 'targets-flow',
				},
				{
					id: 'op-update',
					key: 'update',
					type: 'item-update',
					options: {},
					resolve: null,
					reject: 'op-capture',
					flow: 'targets-flow',
				},
				{
					id: 'op-capture',
					key: 'after',
					type: 'capture',
					options: {},
					resolve: null,
					reject: null,
					flow: 'targets-flow',
				},
			],
		},
	];
}

describe('stored targets survive loading a text options column', () => {
	let update: ReturnType<typeof vi.fn>;
	let captured: unknown[];
	let gates: Array<() => void>;

	beforeEach(() => {
		const manager = getFlowManager() as any;
		manager.clearOperations();
		manager.isLoaded = false;
		manager.operationFlowHandlers = {};

		update = vi.fn(() => null);
		captured = [];
		gates = [];

		manager.addOperation('item-update', update, true);

		manager.addOperation('gate', () => new Promise<void>((resolve) => gates.push(resolve)));

		manager.addOperation('capture', ((_options: unknown, context: Record<string, any>) => {
			captured.push(context['data']['$last']);
			return null;
		}) as any);
	});

	async function run() {
		const manager = getFlowManager() as any;
		const pending = manager.operationFlowHandlers['targets-flow']({}, { accountability: null });
		await vi.waitFor(() => expect(gates.length).toBeGreaterThan(0));
		gates.shift()!();
		await pending;
	}

	it('refuses a keyed Update whose saved query the shared parser would strip to nothing', async () => {
		storeFlow(CONFLICT);
		await (getFlowManager() as any).load();

		await run();

		expect(update).not.toHaveBeenCalled();
		expect(captured).toEqual([expect.objectContaining({ code: 'INVALID_CONFIG' })]);
	});

	it('runs a keyed Update whose saved query is empty', async () => {
		storeFlow(VALID);
		await (getFlowManager() as any).load();

		await run();

		expect(update).toHaveBeenCalledOnce();
		expect(captured).toEqual([]);
	});

	function expectOutcome(outcome: 'runs' | 'refuses') {
		if (outcome === 'runs') {
			expect(update).toHaveBeenCalledOnce();
			expect(captured).toEqual([]);
		} else {
			expect(update).not.toHaveBeenCalled();
			expect(captured).toEqual([expect.objectContaining({ code: 'INVALID_CONFIG' })]);
		}

		update.mockClear();
		captured = [];
	}

	it.each([
		{ before: VALID, after: CONFLICT, original: 'runs', fresh: 'refuses' },
		{ before: CONFLICT, after: VALID, original: 'refuses', fresh: 'runs' },
	] as const)(
		'a run paused across a reload $original under its own definition, and a fresh run $fresh',
		async ({ before, after, original, fresh }) => {
			const manager = getFlowManager() as any;

			storeFlow(before);
			await manager.load();
			const paused = manager.operationFlowHandlers['targets-flow']({}, { accountability: null });
			await vi.waitFor(() => expect(gates.length).toBe(1));

			storeFlow(after);
			await manager.unload();
			await manager.load();

			gates.shift()!();
			await paused;
			expectOutcome(original);

			await run();
			expectOutcome(fresh);
		}
	);
});
