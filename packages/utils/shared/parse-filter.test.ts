import { vi, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Filter } from '@cairncms/types';
import { parseFilter } from './parse-filter.js';

describe('', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(1632431505992));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns the filter when passed accountability with only a role', () => {
		const mockFilter = { _and: [{ field: { _eq: 'field' } }] } as Filter;
		const mockAccountability = { role: 'admin' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockFilter);
	});

	it('returns the filter includes an _in it parses the filter with a deepMap', () => {
		const mockFilter = {
			_and: [
				{
					status: {
						_in: 'published',
					},
				},
			],
		} as Filter;

		const mockResult = {
			_and: [
				{
					status: {
						_in: ['published'],
					},
				},
			],
		} as Filter;

		const mockAccountability = { role: 'admin' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockResult);
	});

	it('returns the filter includes an _in it parses the filter with a deepMap', () => {
		const mockFilter = {
			_and: [
				{
					status: {
						_in: 'published,draft',
					},
				},
			],
		} as Filter;

		const mockResult = {
			_and: [
				{
					status: {
						_in: ['published', 'draft'],
					},
				},
			],
		} as Filter;

		const mockAccountability = { role: 'admin' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockResult);
	});

	it('returns the date', () => {
		const mockFilter = {
			_and: [
				{
					date: {
						_eq: '$NOW',
					},
				},
			],
		} as Filter;

		const mockResult = {
			_and: [
				{
					date: {
						_eq: new Date(),
					},
				},
			],
		} as Filter;

		const mockAccountability = { role: 'admin' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockResult);
	});

	it('returns the filter includes an _in it parses the filter with a deepMap', () => {
		const mockFilter = {
			_and: [
				{
					status: {
						_in: ['published', 'draft'],
					},
				},
			],
		} as Filter;

		const mockAccountability = { role: 'admin' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockFilter);
	});

	it('does proper type casting', () => {
		const mockFilter = {
			_and: [
				{
					status: {
						_eq: 'true',
					},
				},
				{
					field: {
						_eq: 'false',
					},
				},
				{
					field2: {
						_eq: 'null',
					},
				},
			],
		} as Filter;

		const mockResult = {
			_and: [
				{
					status: {
						_eq: true,
					},
				},
				{
					field: {
						_eq: false,
					},
				},
				{
					field2: {
						_eq: null,
					},
				},
			],
		};

		const mockAccountability = { role: 'admin' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockResult);
	});

	it('replaces the user from accountability to $CURRENT_USER', () => {
		const mockFilter = {
			_and: [
				{
					owner: {
						_eq: '$CURRENT_USER',
					},
				},
			],
		} as Filter;

		const mockResult = {
			_and: [
				{
					owner: {
						_eq: 'user',
					},
				},
			],
		} as Filter;

		const mockAccountability = { role: 'admin', user: 'user' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockResult);
	});

	it('replaces the role from accountability to $CURRENT_ROLE', () => {
		const mockFilter = {
			_and: [
				{
					owner: {
						_eq: '$CURRENT_ROLE',
					},
				},
			],
		} as Filter;

		const mockResult = {
			_and: [
				{
					owner: {
						_eq: 'admin',
					},
				},
			],
		} as Filter;

		const mockAccountability = { role: 'admin' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockResult);
	});

	it('adjusts the date by 1 day', () => {
		const mockFilter = {
			date: {
				_eq: '$NOW(-1 day)',
			},
		} as Filter;

		const mockResult = {
			date: {
				_eq: new Date('2021-09-22T21:11:45.992Z'),
			},
		} as Filter;

		const mockAccountability = { role: 'admin', user: 'user' };
		expect(parseFilter(mockFilter, mockAccountability)).toStrictEqual(mockResult);
	});

	it('substitutes an empty $CURRENT_USER scalar-array path into _in []', () => {
		const mockFilter = { role: { _in: '$CURRENT_USER.allowed_roles' } } as Filter;
		const mockAccountability = { role: 'admin', user: 'user' };
		const mockContext = { $CURRENT_USER: { allowed_roles: [] } } as any;

		expect(parseFilter(mockFilter, mockAccountability, mockContext)).toStrictEqual({
			role: { _in: [] },
		});
	});

	it('substitutes an empty $CURRENT_USER relational path into _in []', () => {
		const mockFilter = { role: { _in: '$CURRENT_USER.user_roles.role' } } as Filter;
		const mockAccountability = { role: 'admin', user: 'user' };
		const mockContext = { $CURRENT_USER: { user_roles: [] } } as any;

		expect(parseFilter(mockFilter, mockAccountability, mockContext)).toStrictEqual({
			role: { _in: [] },
		});
	});
});

describe('non-object filter inputs', () => {
	it('does not recurse infinitely when the filter is a top-level string', () => {
		expect(() => parseFilter('filter' as any, null)).not.toThrow();
	});

	it('does not recurse infinitely on a single-character string filter', () => {
		expect(() => parseFilter('a' as any, null)).not.toThrow();
	});

	it('wraps a top-level string as { _eq: <string> }', () => {
		expect(parseFilter('filter' as any, null)).toStrictEqual({ _eq: 'filter' });
	});

	it('wraps a top-level number as { _eq: <number> }', () => {
		expect(parseFilter(42 as any, null)).toStrictEqual({ _eq: 42 });
	});

	it('wraps a top-level boolean as { _eq: <boolean> }', () => {
		expect(parseFilter(true as any, null)).toStrictEqual({ _eq: true });
	});
});
