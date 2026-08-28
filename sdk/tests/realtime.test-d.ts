import { assertType, describe, test } from 'vitest';
import { createCairnCMS } from '../src/index.js';
import { realtime } from '../src/realtime/composable.js';
import type { SubscribeOptions, SubscriptionOptionsEvents } from '../src/realtime/types.js';
import type { TestSchema } from './schema.js';

const client = createCairnCMS<TestSchema>('http://localhost:8055').with(realtime());

type YieldOf<T> = T extends AsyncGenerator<infer Y, any, any> ? Y : never;
type FrameOf<R extends Promise<{ subscription: AsyncGenerator<any, any, any> }>> = YieldOf<Awaited<R>['subscription']>;

// Never invoked at runtime: declared only so its return type can be inspected at the type level.
const samples = {
	unset: () => client.subscribe('collection_a'),
	create: () => client.subscribe('collection_a', { event: 'create' }),
	deleteFeed: () => client.subscribe('collection_a', { event: 'delete' }),
};

describe('realtime delete-feed contract', () => {
	test('a delete feed cannot carry a query', () => {
		const optionShapes = () => {
			void client.subscribe('collection_a', { event: 'delete' });
			void client.subscribe('collection_a', { event: 'create', query: { fields: ['id'] } });
			void client.subscribe('collection_a', { event: 'update' });
			void client.subscribe('collection_a', { query: { fields: ['id'] } });

			// @ts-expect-error - a delete subscription cannot include a query
			void client.subscribe('collection_a', { event: 'delete', query: { fields: ['id'] } });
		};

		assertType<() => void>(optionShapes);
	});

	test('an event-unset subscription never yields a delete variant', () => {
		type Event = FrameOf<ReturnType<typeof samples.unset>>['event'];

		assertType<Event>('init');
		assertType<Event>('create');
		assertType<Event>('update');

		// @ts-expect-error - the impossible error variant is no longer part of the output union
		assertType<Event>('error');

		// @ts-expect-error - delete is not delivered when the event is unset
		assertType<Event>('delete');
	});

	test('a create subscription does not promise a delete variant', () => {
		type Event = FrameOf<ReturnType<typeof samples.create>>['event'];

		assertType<Event>('create');

		// @ts-expect-error - a create feed does not deliver delete
		assertType<Event>('delete');
	});

	test('a delete subscription yields an id-array payload', () => {
		type DeleteFrame = Extract<FrameOf<ReturnType<typeof samples.deleteFeed>>, { event: 'delete' }>;

		assertType<DeleteFrame['data']>([1, 2, 3]);
		assertType<DeleteFrame['data']>(['a', 'b']);

		// @ts-expect-error - a delete feed yields keys, never full items
		assertType<DeleteFrame['data']>([{ id: 1 }]);
	});

	test('a dynamic event keeps delete in the output type rather than erasing it', () => {
		// a function parameter stays the full union (TS cannot narrow it to a literal), unlike a const
		const dynamic = (event: SubscriptionOptionsEvents) => client.subscribe('collection_a', { event });

		type Event = FrameOf<ReturnType<typeof dynamic>>['event'];

		// a runtime-chosen event can be delete, so the output must keep every variant the caller can send
		assertType<Event>('create');
		assertType<Event>('update');
		assertType<Event>('delete');
	});

	test('a dynamic event that could be delete cannot carry a query', () => {
		const shapes = (event: SubscriptionOptionsEvents) => {
			void client.subscribe('collection_a', { event });

			// @ts-expect-error - delete is a possible runtime value, so the query is rejected
			void client.subscribe('collection_a', { event, query: { fields: ['id'] } });
		};

		assertType<(event: SubscriptionOptionsEvents) => void>(shapes);
	});

	test('a dynamic event that cannot be delete still accepts a query', () => {
		const shapes = (event: 'create' | 'update') => {
			void client.subscribe('collection_a', { event, query: { fields: ['id'] } });
		};

		assertType<(event: 'create' | 'update') => void>(shapes);
	});

	test('a pretyped delete-capable event cannot be combined with a query', () => {
		const build = (event: SubscriptionOptionsEvents) => {
			// @ts-expect-error - a delete-capable event and a query cannot coexist, even through a pretyped options object
			const invalid: SubscribeOptions<TestSchema, 'collection_a'> = { event, query: { fields: ['id'] } };
			void invalid;
		};

		assertType<(event: SubscriptionOptionsEvents) => void>(build);
	});

	test('pretyped create/update subscriptions and wrappers over SubscribeOptions stay valid', () => {
		const createWithQuery: SubscribeOptions<TestSchema, 'collection_a'> = {
			event: 'create',
			query: { fields: ['id'] },
		};

		void client.subscribe('collection_a', createWithQuery);

		const watch = (options: SubscribeOptions<TestSchema, 'collection_a'>) => client.subscribe('collection_a', options);
		assertType<(options: SubscribeOptions<TestSchema, 'collection_a'>) => Promise<unknown>>(watch);
	});
});
