import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => ({
	default: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { cockroachAfterCreate, createMysqlAfterCreate, sqliteAfterCreate } from './connection-hooks.js';

type DriverCallback = (error: unknown, result?: unknown) => void;

function deferredDriver() {
	const calls: string[] = [];
	const resolvers: DriverCallback[] = [];

	const driver = (sql: string, cb: DriverCallback) => {
		calls.push(sql);
		resolvers.push(cb);
	};

	return { calls, resolvers, driver };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('sqliteAfterCreate', () => {
	it('is synchronous and returns undefined, not a promise', () => {
		const { driver } = deferredDriver();

		expect(sqliteAfterCreate({ run: driver }, vi.fn())).toBeUndefined();
	});

	it('runs the pragmas in order and reports success only after the last one', async () => {
		const { calls, resolvers, driver } = deferredDriver();
		const conn = { run: driver };
		const callback = vi.fn();

		sqliteAfterCreate(conn, callback);

		await vi.waitFor(() => expect(calls).toEqual(['PRAGMA foreign_keys = ON']));
		expect(callback).not.toHaveBeenCalled();

		resolvers[0]!(null);

		await vi.waitFor(() => expect(calls).toEqual(['PRAGMA foreign_keys = ON', 'PRAGMA busy_timeout = 5000']));
		expect(callback).not.toHaveBeenCalled();

		resolvers[1]!(null);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]).toEqual([null, conn]);
	});

	it('forwards a first-statement failure exactly once and never runs the second', async () => {
		const { calls, resolvers, driver } = deferredDriver();
		const callback = vi.fn();
		const failure = new Error('foreign_keys failed');

		sqliteAfterCreate({ run: driver }, callback);

		await vi.waitFor(() => expect(calls).toHaveLength(1));
		resolvers[0]!(failure);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]![0]).toBe(failure);
		expect(calls).toEqual(['PRAGMA foreign_keys = ON']);
	});

	it('forwards a second-statement failure exactly once', async () => {
		const { resolvers, driver } = deferredDriver();
		const callback = vi.fn();
		const failure = new Error('busy_timeout failed');

		sqliteAfterCreate({ run: driver }, callback);

		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		resolvers[0]!(null);
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));
		resolvers[1]!(failure);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]![0]).toBe(failure);
	});
});

describe('cockroachAfterCreate', () => {
	it('is synchronous and returns undefined, not a promise', () => {
		const { driver } = deferredDriver();

		expect(cockroachAfterCreate({ query: driver }, vi.fn())).toBeUndefined();
	});

	it('runs the statements in order and reports success only after the last one', async () => {
		const { calls, resolvers, driver } = deferredDriver();
		const conn = { query: driver };
		const callback = vi.fn();

		cockroachAfterCreate(conn, callback);

		await vi.waitFor(() => expect(calls).toEqual(['SET serial_normalization = "sql_sequence"']));
		expect(callback).not.toHaveBeenCalled();

		resolvers[0]!(null);

		await vi.waitFor(() =>
			expect(calls).toEqual(['SET serial_normalization = "sql_sequence"', 'SET default_int_size = 4'])
		);

		expect(callback).not.toHaveBeenCalled();

		resolvers[1]!(null);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]).toEqual([null, conn]);
	});

	it('forwards a first-statement failure exactly once and never runs the second', async () => {
		const { calls, resolvers, driver } = deferredDriver();
		const callback = vi.fn();
		const failure = new Error('serial_normalization failed');

		cockroachAfterCreate({ query: driver }, callback);

		await vi.waitFor(() => expect(calls).toHaveLength(1));
		resolvers[0]!(failure);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]![0]).toBe(failure);
		expect(calls).toEqual(['SET serial_normalization = "sql_sequence"']);
	});

	it('forwards a second-statement failure exactly once', async () => {
		const { resolvers, driver } = deferredDriver();
		const callback = vi.fn();
		const failure = new Error('default_int_size failed');

		cockroachAfterCreate({ query: driver }, callback);

		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		resolvers[0]!(null);
		await vi.waitFor(() => expect(resolvers).toHaveLength(2));
		resolvers[1]!(failure);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]![0]).toBe(failure);
	});
});

describe('createMysqlAfterCreate', () => {
	it('is synchronous and returns undefined, not a promise', () => {
		const { driver } = deferredDriver();

		expect(createMysqlAfterCreate(vi.fn())({ query: driver }, vi.fn())).toBeUndefined();
	});

	it('records the version before reporting success', async () => {
		const { calls, resolvers, driver } = deferredDriver();
		const conn = { query: driver };
		const onVersion = vi.fn();
		const callback = vi.fn();

		createMysqlAfterCreate(onVersion)(conn, callback);

		await vi.waitFor(() => expect(calls).toEqual(['SELECT @@version;']));
		expect(onVersion).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();

		resolvers[0]!(null, [{ '@@version': '8.0.36' }]);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(onVersion).toHaveBeenCalledTimes(1);
		expect(onVersion).toHaveBeenCalledWith('8.0.36');
		expect(onVersion.mock.invocationCallOrder[0]!).toBeLessThan(callback.mock.invocationCallOrder[0]!);
		expect(callback.mock.calls[0]).toEqual([null, conn]);
	});

	it('forwards a query failure exactly once and never records a version', async () => {
		const { resolvers, driver } = deferredDriver();
		const onVersion = vi.fn();
		const callback = vi.fn();
		const failure = new Error('version query failed');

		createMysqlAfterCreate(onVersion)({ query: driver }, callback);

		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		resolvers[0]!(failure);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]![0]).toBe(failure);
		expect(onVersion).not.toHaveBeenCalled();
	});

	it('forwards an error when the version result is empty', async () => {
		const { resolvers, driver } = deferredDriver();
		const onVersion = vi.fn();
		const callback = vi.fn();

		createMysqlAfterCreate(onVersion)({ query: driver }, callback);

		await vi.waitFor(() => expect(resolvers).toHaveLength(1));
		resolvers[0]!(null, []);

		await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
		expect(callback.mock.calls[0]![0]).toBeInstanceOf(TypeError);
		expect(onVersion).not.toHaveBeenCalled();
	});
});
