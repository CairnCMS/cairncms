import { describe, expect, it } from 'vitest';
import { OperationSequencer } from './operation-sequencer.js';

interface Delivery {
	resolve: () => void;
}

function harness() {
	const delivered: string[] = [];
	const deliveries = new Map<string, Delivery>();
	const tracked: Promise<unknown>[] = [];

	const deliver = (frame: string): Promise<void> => {
		delivered.push(frame);

		return new Promise<void>((resolve) => {
			deliveries.set(frame, { resolve });
		});
	};

	const sequencer = new OperationSequencer(deliver, (work) => {
		tracked.push(work);
	});

	return { sequencer, delivered, deliveries, tracked };
}

async function settle(): Promise<void> {
	for (let index = 0; index < 6; index++) await new Promise((resolve) => setImmediate(resolve));
}

describe('OperationSequencer', () => {
	it('delivers a fresh subscribe immediately and keeps its lane while it is live', async () => {
		const { sequencer, delivered } = harness();

		sequencer.route('x', 'subscribe', 'A');
		await settle();

		expect(delivered).toEqual(['A']);
		expect(sequencer.size).toBe(1);
	});

	it('holds a reused subscribe until its predecessor lifetime settles', async () => {
		const { sequencer, delivered, deliveries } = harness();

		sequencer.route('x', 'subscribe', 'A');
		await settle();
		sequencer.route('x', 'complete', 'cA');
		await settle();
		sequencer.route('x', 'subscribe', 'B');
		await settle();

		expect(delivered).toEqual(['A', 'cA']);

		deliveries.get('A')!.resolve();
		await settle();

		expect(delivered).toEqual(['A', 'cA', 'B']);
	});

	it('orders a completion for a queued successor behind that successor starting', async () => {
		const { sequencer, delivered, deliveries } = harness();

		sequencer.route('x', 'subscribe', 'A');
		await settle();
		sequencer.route('x', 'complete', 'cA');
		await settle();
		sequencer.route('x', 'subscribe', 'B');
		await settle();
		sequencer.route('x', 'complete', 'cB');
		await settle();

		expect(delivered).toEqual(['A', 'cA']);

		deliveries.get('A')!.resolve();
		await settle();

		expect(delivered).toEqual(['A', 'cA', 'B', 'cB']);
	});

	it('cancels a queued successor on shutdown and drains without hanging', async () => {
		const { sequencer, delivered, deliveries, tracked } = harness();

		sequencer.route('x', 'subscribe', 'A');
		await settle();
		sequencer.route('x', 'complete', 'cA');
		await settle();
		sequencer.route('x', 'subscribe', 'B');
		await settle();

		expect(delivered).toEqual(['A', 'cA']);

		sequencer.cancel();
		for (const delivery of deliveries.values()) delivery.resolve();
		await settle();

		expect(delivered).toEqual(['A', 'cA']);

		await Promise.all(tracked.map((work) => work.catch(() => undefined)));
		expect(sequencer.size).toBe(0);
	});

	it('retains no state for completions targeting unknown ids', async () => {
		const { sequencer, delivered } = harness();

		for (let index = 0; index < 50; index++) sequencer.route(`u${index}`, 'complete', `c${index}`);

		await settle();

		expect(delivered).toHaveLength(50);
		expect(sequencer.size).toBe(0);
	});

	it('reaps lane state so sequential unique ids stay bounded', async () => {
		const { sequencer, deliveries } = harness();

		for (let index = 0; index < 50; index++) {
			sequencer.route(`k${index}`, 'subscribe', `s${index}`);
			await settle();
			sequencer.route(`k${index}`, 'complete', `x${index}`);
			await settle();
			deliveries.get(`s${index}`)!.resolve();
			await settle();
		}

		expect(sequencer.size).toBe(0);
	});

	it('delivers a live duplicate subscribe to the library so it can be rejected', async () => {
		const { sequencer, delivered } = harness();

		sequencer.route('x', 'subscribe', 'A');
		await settle();
		sequencer.route('x', 'subscribe', 'A2');
		await settle();

		expect(delivered).toEqual(['A', 'A2']);
	});

	it('delivers a duplicate queued behind a reuse once that reuse starts', async () => {
		const { sequencer, delivered, deliveries } = harness();

		sequencer.route('x', 'subscribe', 'A');
		await settle();
		sequencer.route('x', 'complete', 'cA');
		await settle();
		sequencer.route('x', 'subscribe', 'B');
		await settle();
		sequencer.route('x', 'subscribe', 'B2');
		await settle();

		expect(delivered).toEqual(['A', 'cA']);

		deliveries.get('A')!.resolve();
		await settle();

		expect(delivered).toEqual(['A', 'cA', 'B', 'B2']);
	});
});
