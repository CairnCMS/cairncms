import { describe, expect, test } from 'vitest';
import { MAX_SNAPSHOT_DEPTH, snapshotError, toPlainData } from './error-snapshot.js';

describe('snapshotError', () => {
	test('captures a native error type, message, and stack', () => {
		const snap = snapshotError(new Error('boom')) as any;
		expect(snap.type).toBe('Error');
		expect(snap.message).toBe('boom');
		expect(typeof snap.stack).toBe('string');
	});

	test('uses the constructor name as type and adds no separate name field', () => {
		class CustomError extends Error {}

		const snap = snapshotError(new CustomError('boom')) as any;
		expect(snap.type).toBe('CustomError');
		expect('name' in snap).toBe(false);
	});

	test('captures enumerable own properties', () => {
		const error = Object.assign(new Error('boom'), { status: 400, code: 'BAD', extensions: { field: 'x' } });
		const snap = snapshotError(error) as any;
		expect(snap.status).toBe(400);
		expect(snap.code).toBe('BAD');
		expect(snap.extensions).toEqual({ field: 'x' });
	});

	test('captures a nested cause chain with its structured fields', () => {
		const inner = Object.assign(new Error('inner'), { extensions: { password: 'sekret' } });
		const snap = snapshotError(new Error('outer', { cause: inner })) as any;
		expect(snap.cause.type).toBe('Error');
		expect(snap.cause.message).toBe('inner');
		expect(snap.cause.extensions.password).toBe('sekret');
	});

	test('captures AggregateError.errors as aggregateErrors and no errors field', () => {
		const snap = snapshotError(new AggregateError([new Error('a'), new Error('b')], 'multi')) as any;
		expect(snap.aggregateErrors).toHaveLength(2);
		expect(snap.aggregateErrors[0].message).toBe('a');
		expect(snap.aggregateErrors[1].message).toBe('b');
		expect('errors' in snap).toBe(false);
	});

	test('excludes originalError from the snapshot', () => {
		const outer = new Error('outer');
		Object.defineProperty(outer, 'originalError', { value: new Error('inner'), enumerable: true, configurable: true });
		const snap = snapshotError(outer);
		expect('originalError' in snap).toBe(false);
	});

	test('reads each property once, so a getter is invoked a single time', () => {
		let reads = 0;

		const error = Object.assign(new Error('boom'), {
			extensions: {
				get token() {
					reads++;
					return 'secret';
				},
			},
		});

		snapshotError(error);
		expect(reads).toBe(1);
	});

	test('materializes Date to its ISO string and Buffer to its JSON form', () => {
		const error = Object.assign(new Error('boom'), {
			extensions: { when: new Date('2026-05-01T12:00:00.000Z'), data: Buffer.from('hi') },
		});

		const snap = snapshotError(error) as any;
		expect(snap.extensions.when).toBe('2026-05-01T12:00:00.000Z');
		expect(snap.extensions.data).toEqual({ type: 'Buffer', data: [104, 105] });
	});

	test('preserves booleans and null, and materializes non-finite numbers and bigint', () => {
		const error = Object.assign(new Error('boom'), {
			extensions: { flag: true, missing: null, ratio: Number.POSITIVE_INFINITY, big: 10n },
		});

		const snap = snapshotError(error) as any;
		expect(snap.extensions.flag).toBe(true);
		expect(snap.extensions.missing).toBe(null);
		expect(snap.extensions.ratio).toBe(null);
		expect(snap.extensions.big).toBe('10');
	});

	test('omits functions, symbols, and undefined values', () => {
		const error = Object.assign(new Error('boom'), {
			extensions: { fn: () => 1, sym: Symbol('s'), gone: undefined, kept: 'yes' },
		});

		const snap = snapshotError(error) as any;
		expect(snap.extensions).toEqual({ kept: 'yes' });
	});

	test('shares no reference with the raw error', () => {
		const nested = { value: 'original' };
		const error = Object.assign(new Error('boom'), { extensions: { nested } });
		const snap = snapshotError(error) as any;
		nested.value = 'mutated';
		expect(snap.extensions.nested.value).toBe('original');
	});

	test('guards cycles with a [Circular] marker instead of throwing', () => {
		const ext: Record<string, unknown> = { label: 'x' };
		ext['self'] = ext;
		const error = Object.assign(new Error('boom'), { extensions: ext });
		const snap = snapshotError(error) as any;
		expect(snap.extensions.label).toBe('x');
		expect(snap.extensions.self).toBe('[Circular]');
	});

	test('throws on content deeper than the snapshot depth', () => {
		let deep: Record<string, unknown> = { v: 'bottom' };
		for (let i = 0; i < 200; i++) deep = { next: deep };
		const error = Object.assign(new Error('boom'), { extensions: deep });
		expect(() => snapshotError(error)).toThrow('could not be inspected completely');
		expect(() => toPlainData(deep)).toThrow('could not be inspected completely');
	});

	test('materializes content within the snapshot depth', () => {
		let deep: Record<string, unknown> = { v: 'bottom' };
		for (let i = 0; i < MAX_SNAPSHOT_DEPTH - 2; i++) deep = { next: deep };
		const error = Object.assign(new Error('boom'), { extensions: deep });
		expect(JSON.stringify(snapshotError(error))).toContain('bottom');
	});

	test('walks a self-returning toJSON through its own fields, as JSON.stringify does', () => {
		const evil: { toJSON: () => unknown; label: string } = { toJSON: () => evil, label: 'kept' };
		const error = Object.assign(new Error('boom'), { extensions: { evil } });
		expect((snapshotError(error) as any).extensions.evil).toEqual({ label: 'kept' });
		expect(JSON.parse(JSON.stringify(evil))).toEqual({ label: 'kept' });
	});

	test('reads a self-returning toJSON getter once and keeps the fields it could hide', () => {
		let reads = 0;
		const detail: Record<string, unknown> = { password: 'kept-secret' };

		Object.defineProperty(detail, 'toJSON', {
			enumerable: true,
			get() {
				reads++;
				if (reads > 1) delete detail['password'];

				return function (this: unknown) {
					return this;
				};
			},
		});

		const snap = snapshotError(Object.assign(new Error('boom'), { extensions: { detail } })) as any;

		expect(reads).toBe(1);
		expect(snap.extensions.detail).toEqual({ password: 'kept-secret' });
	});

	test('captures every field before a nested toJSON can change a sibling', () => {
		const details: Record<string, unknown> = {
			nested: {
				toJSON() {
					delete details['password'];
					return {};
				},
			},
			password: 'kept-secret',
		};

		const snap = snapshotError(Object.assign(new Error('boom'), { extensions: { details } })) as any;
		expect(snap.extensions.details).toEqual({ nested: {}, password: 'kept-secret' });
	});

	test('captures every array item before a nested toJSON can change a later one', () => {
		const list: unknown[] = [];

		list.push({
			toJSON() {
				list[1] = 'changed';
				return {};
			},
		});

		list.push('kept');

		expect(toPlainData({ list })).toEqual({ list: [{}, 'kept'] });
	});

	test('captures every aggregate error before a nested toJSON can change a later one', () => {
		const aggregate = new AggregateError([], 'many');

		aggregate.errors = [
			{
				toJSON() {
					aggregate.errors[1] = 'changed';
					return {};
				},
			},
			'kept',
		];

		expect((snapshotError(aggregate) as any).aggregateErrors).toEqual([{}, 'kept']);
	});

	test('reads array items by index, not through a custom iterator', () => {
		const values: unknown[] = [{ password: 'kept' }];

		values[Symbol.iterator] = function* () {
			yield {};
		};

		expect(toPlainData({ values })).toEqual({ values: [{ password: 'kept' }] });
		expect(JSON.parse(JSON.stringify({ values }))).toEqual({ values: [{ password: 'kept' }] });
	});

	test('reads aggregate errors by index, not through a custom iterator', () => {
		const aggregate = new AggregateError([], 'many');
		const errors: unknown[] = [{ password: 'kept' }];

		errors[Symbol.iterator] = function* () {
			yield {};
		};

		aggregate.errors = errors;

		expect((snapshotError(aggregate) as any).aggregateErrors).toEqual([{ password: 'kept' }]);
	});

	test('keeps array holes as null, as JSON does', () => {
		const values: unknown[] = [];
		values[0] = 1;
		values[2] = 3;

		expect(toPlainData({ values })).toEqual({ values: [1, null, 3] });
		expect(JSON.parse(JSON.stringify({ values }))).toEqual({ values: [1, null, 3] });
	});

	test('calls toJSON once per position and never on its result, as JSON.stringify does', () => {
		const chain = (n: number): { toJSON: () => unknown } => ({
			toJSON: () => (n <= 0 ? { done: true } : chain(n - 1)),
		});

		const error = Object.assign(new Error('boom'), { extensions: { chain: chain(500) } });
		expect((snapshotError(error) as any).extensions.chain).toEqual({});
		expect(JSON.parse(JSON.stringify(chain(500)))).toEqual({});
	});

	test('calls toJSON on the values inside a toJSON result', () => {
		const date = new Date('2026-01-02T03:04:05.000Z');
		const wrapper = { toJSON: () => ({ when: date }) };
		expect(toPlainData({ wrapper })).toEqual({ wrapper: { when: '2026-01-02T03:04:05.000Z' } });
	});

	test('throws on a back-reference beneath a sensitive key', () => {
		const details: Record<string, unknown> = { value: 'shown' };
		details['credentials'] = details;
		const error = Object.assign(new Error('boom'), { extensions: { details } });
		expect(() => snapshotError(error)).toThrow('could not be inspected completely');
	});

	test('throws on a self-returning toJSON beneath a sensitive key', () => {
		const evil: { toJSON: () => unknown } = { toJSON: () => evil };
		evil.toJSON = () => ({ self: evil });
		const error = Object.assign(new Error('boom'), { extensions: { credentials: evil } });
		expect(() => snapshotError(error)).toThrow('could not be inspected completely');
	});

	test('keeps the cycle marker for a back-reference outside sensitive keys', () => {
		const ext: Record<string, unknown> = { password: 'collected' };
		ext['self'] = ext;
		const snap = snapshotError(Object.assign(new Error('boom'), { extensions: ext })) as any;
		expect(snap.extensions).toEqual({ password: 'collected', self: '[Circular]' });
	});

	test('throws on a back-reference to an error beneath a sensitive key', () => {
		const error: Error & { extensions?: unknown } = new Error('boom');
		error.extensions = { token: { owner: error } };
		expect(() => snapshotError(error)).toThrow('could not be inspected completely');
	});

	test('reads an accessor-backed toJSON exactly once', () => {
		let reads = 0;

		const value = {
			get toJSON() {
				reads++;
				return () => ({ materialized: true });
			},
		};

		const error = Object.assign(new Error('boom'), { extensions: { value } });
		const snap = snapshotError(error) as any;
		expect(snap.extensions.value).toEqual({ materialized: true });
		expect(reads).toBe(1);
	});

	test('reads an enumerable constructor property once and uses it as the type', () => {
		let reads = 0;
		const error = new Error('boom');

		Object.defineProperty(error, 'constructor', {
			enumerable: true,
			get() {
				reads++;
				return class NamedError {};
			},
		});

		const snap = snapshotError(error) as any;
		expect(snap.type).toBe('NamedError');
		expect(reads).toBe(1);
	});

	test('wraps a non-object thrown value', () => {
		expect(snapshotError('boom string')).toEqual({ type: 'string', message: 'boom string' });
		expect(snapshotError(42)).toEqual({ type: 'number', message: '42' });
	});
});

describe('toPlainData', () => {
	test('resolves getters once and detaches from the source', () => {
		let reads = 0;

		const source = {
			get token() {
				reads++;
				return 'secret';
			},
			nested: { keep: 'x' },
		};

		const plain = toPlainData(source) as any;
		expect(plain.token).toBe('secret');
		expect(reads).toBe(1);
		source.nested.keep = 'mutated';
		expect(plain.nested.keep).toBe('x');
	});

	test('materializes an array of response-shaped objects unchanged', () => {
		const plain = toPlainData([{ message: 'a', extensions: { code: 'X' } }]);
		expect(plain).toEqual([{ message: 'a', extensions: { code: 'X' } }]);
	});
});
