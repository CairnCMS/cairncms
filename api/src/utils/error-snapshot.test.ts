import { describe, expect, test } from 'vitest';
import { snapshotError, toPlainData } from './error-snapshot.js';

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

	test('captures a non-enumerable originalError by name and recurses it', () => {
		const inner = Object.assign(new Error('inner boom'), { code: 'INNER' });
		const outer = new Error('outer');
		Object.defineProperty(outer, 'originalError', { value: inner, enumerable: false });
		const snap = snapshotError(outer) as any;
		expect(snap.originalError.type).toBe('Error');
		expect(snap.originalError.message).toBe('inner boom');
		expect(snap.originalError.code).toBe('INNER');
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

	test('caps depth on deeply nested structures without throwing', () => {
		let deep: Record<string, unknown> = { v: 'bottom' };
		for (let i = 0; i < 200; i++) deep = { next: deep };
		const error = Object.assign(new Error('boom'), { extensions: deep });
		expect(() => snapshotError(error)).not.toThrow();
		expect(JSON.stringify(snapshotError(error))).toContain('[Max depth exceeded]');
	});

	test('guards a self-returning toJSON with a [Circular] marker instead of overflowing the stack', () => {
		const evil: { toJSON: () => unknown } = { toJSON: () => evil };
		const error = Object.assign(new Error('boom'), { extensions: { evil } });
		expect(() => snapshotError(error)).not.toThrow();
		expect((snapshotError(error) as any).extensions.evil).toBe('[Circular]');
	});

	test('caps a toJSON chain of fresh objects instead of overflowing the stack', () => {
		const chain = (n: number): { toJSON: () => unknown } => ({
			toJSON: () => (n <= 0 ? { done: true } : chain(n - 1)),
		});

		const error = Object.assign(new Error('boom'), { extensions: { chain: chain(500) } });
		expect(() => snapshotError(error)).not.toThrow();
		expect(JSON.stringify(snapshotError(error))).toContain('[Max depth exceeded]');
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
