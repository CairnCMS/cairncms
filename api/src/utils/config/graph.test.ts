import { describe, expect, it } from 'vitest';
import { dependencyClosure, dependencyOrder, reverseDependencyOrder, topologicalOrder } from './graph.js';

function edges(graph: Record<string, string[]>): (node: string) => string[] {
	return (node) => graph[node] ?? [];
}

describe('topologicalOrder', () => {
	it('orders dependencies before dependents', () => {
		expect(topologicalOrder(['b', 'a'], edges({ b: ['a'] }))).toEqual(['a', 'b']);
	});

	it('orders a chain regardless of input order', () => {
		expect(topologicalOrder(['c', 'a', 'b'], edges({ c: ['b'], b: ['a'] }))).toEqual(['a', 'b', 'c']);
	});

	it('returns an empty order for no nodes', () => {
		expect(topologicalOrder([], edges({}))).toEqual([]);
	});

	it('preserves input order for independent nodes', () => {
		expect(topologicalOrder(['b', 'a', 'c'], edges({}))).toEqual(['b', 'a', 'c']);
	});

	it('keeps independent nodes in input order around a dependency edge', () => {
		expect(topologicalOrder(['b', 'a', 'c'], edges({ c: ['a'] }))).toEqual(['b', 'a', 'c']);
	});

	it('throws on a direct cycle', () => {
		expect(() => topologicalOrder(['a', 'b'], edges({ a: ['b'], b: ['a'] }))).toThrow(/cycle/i);
	});

	it('throws on a self dependency', () => {
		expect(() => topologicalOrder(['a'], edges({ a: ['a'] }))).toThrow(/cycle/i);
	});

	it('throws on a dependency outside the node set', () => {
		expect(() => topologicalOrder(['a'], edges({ a: ['ghost'] }))).toThrow(/unknown dependency "ghost"/i);
	});
});

describe('dependencyClosure', () => {
	it('includes the seeds', () => {
		expect(dependencyClosure(['a'], edges({}))).toEqual(new Set(['a']));
	});

	it('follows a transitive chain', () => {
		expect(dependencyClosure(['c'], edges({ c: ['b'], b: ['a'] }))).toEqual(new Set(['c', 'b', 'a']));
	});

	it('reaches a shared dependency once through a diamond', () => {
		expect(dependencyClosure(['d'], edges({ d: ['b', 'c'], b: ['a'], c: ['a'] }))).toEqual(
			new Set(['d', 'b', 'c', 'a'])
		);
	});
});

describe('dependencyOrder over the config registry', () => {
	it('orders roles before permissions', () => {
		expect(dependencyOrder(['permissions', 'roles'])).toEqual(['roles', 'permissions']);
	});

	it('returns a single managed kind unchanged', () => {
		expect(dependencyOrder(['permissions'])).toEqual(['permissions']);
		expect(dependencyOrder(['roles'])).toEqual(['roles']);
	});

	it('returns an empty order for no kinds', () => {
		expect(dependencyOrder([])).toEqual([]);
	});

	it('reverses to dependents first for deletion traversal', () => {
		expect(reverseDependencyOrder(['roles', 'permissions'])).toEqual(['permissions', 'roles']);
	});
});
