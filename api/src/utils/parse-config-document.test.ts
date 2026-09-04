import { dump as dumpYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import {
	CONFIG_MAX_COLLECTION_ALIASES,
	CONFIG_MAX_DEPTH,
	assertConfigValueSafe,
	parseConfigYaml,
} from './parse-config-document.js';

function nest(levels: number): unknown {
	return wrap('leaf', levels);
}

function wrap(value: unknown, levels: number): unknown {
	let wrapped = value;

	for (let index = 0; index < levels; index++) {
		wrapped = { a: wrapped };
	}

	return wrapped;
}

function flowNest(levels: number, leaf: string): string {
	let out = leaf;

	for (let index = 0; index < levels; index++) {
		out = `{a: ${out}}`;
	}

	return out;
}

function yamlNest(levels: number): string {
	let out = '';

	for (let index = 0; index < levels; index++) {
		out += `${' '.repeat(index * 2)}a:\n`;
	}

	return `${out}${' '.repeat(levels * 2)}leaf\n`;
}

describe('parseConfigYaml', () => {
	it('resolves merge keys so a shared permission filter stays merged', () => {
		const parsed = parseConfigYaml(
			['defaults: &defaults', '  status: published', 'filter:', '  <<: *defaults', '  author: me', ''].join('\n'),
			'permissions/editor.yaml'
		) as Record<string, Record<string, unknown>>;

		expect(parsed['filter']).toEqual({ status: 'published', author: 'me' });
	});

	it('rejects an executable tag', () => {
		expect(() => parseConfigYaml('fn: !!js/function "function () {}"', 'roles/editor.yaml')).toThrow(
			ConfigInvalidException
		);
	});

	it('rejects a duplicate mapping key rather than keeping the last one', () => {
		expect(() => parseConfigYaml(['read: true', 'read: false', ''].join('\n'), 'roles/editor.yaml')).toThrow(
			ConfigInvalidException
		);
	});

	it('normalizes a timestamp to an ISO string at any depth', () => {
		const parsed = parseConfigYaml(['meta:', '  created: 2024-01-01', ''].join('\n'), 'roles/editor.yaml') as Record<
			string,
			Record<string, unknown>
		>;

		expect(parsed['meta']!['created']).toBe('2024-01-01T00:00:00.000Z');
	});

	it('rejects a binary tag, which would otherwise persist as an index-keyed object', () => {
		expect(() => parseConfigYaml('filter: !!binary aGk=', 'permissions/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('rejects non-finite numbers, which would otherwise persist as null', () => {
		expect(() => parseConfigYaml('filter:\n  score: .inf\n', 'permissions/editor.yaml')).toThrow(
			ConfigInvalidException
		);

		expect(() => parseConfigYaml('filter:\n  score: .nan\n', 'permissions/editor.yaml')).toThrow(
			ConfigInvalidException
		);
	});

	it('rejects a document that references itself', () => {
		expect(() => parseConfigYaml('root: &loop\n  child: *loop\n', 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('rejects an empty document', () => {
		expect(() => parseConfigYaml('', 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('reports a parse position without echoing the offending source line', () => {
		let message = '';

		try {
			parseConfigYaml('password: "hunter2\n', 'roles/editor.yaml');
		} catch (err) {
			message = (err as Error).message;
		}

		expect(message).not.toBe('');
		expect(message).not.toContain('hunter2');
		expect(message).toContain('roles/editor.yaml');
		expect(message).toMatch(/line \d+, column \d+/);
	});

	it('accepts the deepest supported document and rejects one level beyond it', () => {
		const deepest = { root: nest(CONFIG_MAX_DEPTH - 1) };
		const beyond = { root: nest(CONFIG_MAX_DEPTH) };

		expect(() => assertConfigValueSafe(deepest, 'roles/editor.yaml')).not.toThrow();
		expect(() => assertConfigValueSafe(beyond, 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('accepts the most supported collection aliases and rejects one beyond it', () => {
		const shared = { x: 1 };
		const atLimit = { base: shared, refs: Array.from({ length: CONFIG_MAX_COLLECTION_ALIASES }, () => shared) };

		const beyond = {
			base: shared,
			refs: Array.from({ length: CONFIG_MAX_COLLECTION_ALIASES + 1 }, () => shared),
		};

		expect(() => assertConfigValueSafe(atLimit, 'roles/editor.yaml')).not.toThrow();
		expect(() => assertConfigValueSafe(beyond, 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('does not count repeated scalars against the collection alias bound', () => {
		const repeated = Array.from({ length: CONFIG_MAX_COLLECTION_ALIASES * 10 }, () => 'shared');

		expect(() => assertConfigValueSafe({ refs: repeated }, 'roles/editor.yaml')).not.toThrow();
	});

	it('reports a shared collection as an alias rather than as a cycle', () => {
		const shared = { x: 1 };

		expect(() => assertConfigValueSafe({ first: shared, second: shared }, 'roles/editor.yaml')).not.toThrow();
	});

	it('applies the collection alias bound to real anchors and aliases', () => {
		const refs = Array.from({ length: CONFIG_MAX_COLLECTION_ALIASES + 1 }, () => '*shared').join(', ');

		expect(() => parseConfigYaml(`base: &shared {x: 1}\nrefs: [${refs}]\n`, 'permissions/editor.yaml')).toThrow(
			ConfigInvalidException
		);
	});

	it('measures a repeated collection at every position it occupies, not only the first', () => {
		const shared = nest(20);
		const value = { shallow: shared, deep: wrap(shared, 85) };

		expect(() => assertConfigValueSafe(value, 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('refuses a document whose aliases would expand past the depth bound when written back out', () => {
		const document = `shared: &s ${flowNest(20, 'leaf')}\ndeep: ${flowNest(85, '*s')}\n`;

		expect(() => parseConfigYaml(document, 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('accepts a document that survives being written back out with aliases expanded', () => {
		const document = `shared: &s {a: {b: 1}}\nfirst: *s\nsecond: *s\n`;
		const parsed = parseConfigYaml(document, 'roles/editor.yaml');
		const written = dumpYaml(parsed, { indent: 2, sortKeys: true, lineWidth: -1, noRefs: true });

		expect(() => parseConfigYaml(written, 'roles/editor.yaml')).not.toThrow();
		expect(parseConfigYaml(written, 'roles/editor.yaml')).toEqual(parsed);
	});

	it('applies its own depth bound rather than the parser default, which is stricter', () => {
		let message = '';

		try {
			parseConfigYaml(yamlNest(CONFIG_MAX_DEPTH + 1), 'roles/editor.yaml');
		} catch (err) {
			message = (err as Error).message;
		}

		expect(() => parseConfigYaml(yamlNest(CONFIG_MAX_DEPTH), 'roles/editor.yaml')).not.toThrow();
		expect(message).toContain(String(CONFIG_MAX_DEPTH));
	});

	it('wraps the parser depth guard for a document deeper than the raised parser bound', () => {
		let error: unknown;

		try {
			parseConfigYaml(yamlNest(CONFIG_MAX_DEPTH * 2 + 10), 'roles/editor.yaml');
		} catch (err) {
			error = err;
		}

		expect(error).toBeInstanceOf(ConfigInvalidException);
		expect((error as Error).message).toContain('could not be parsed');
	});

	it('bounds a merge sequence at the alias limit, above the stricter parser default', () => {
		const mergeDocument = (count: number) => {
			const anchors = Array.from({ length: count }, (_, index) => `d${index}: &a${index} {x${index}: ${index}}`);
			const refs = Array.from({ length: count }, (_, index) => `*a${index}`).join(', ');

			return `${anchors.join('\n')}\nm:\n  <<: [${refs}]\n`;
		};

		expect(() => parseConfigYaml(mergeDocument(21), 'roles/editor.yaml')).not.toThrow();
		expect(() => parseConfigYaml(mergeDocument(CONFIG_MAX_COLLECTION_ALIASES), 'roles/editor.yaml')).not.toThrow();

		expect(() => parseConfigYaml(mergeDocument(CONFIG_MAX_COLLECTION_ALIASES + 1), 'roles/editor.yaml')).toThrow(
			ConfigInvalidException
		);
	});

	it('bounds single-alias merges repeated across many mappings', () => {
		const repeatedMerges = (count: number) => {
			const mappings = Array.from({ length: count }, (_, index) => `m${index}:\n  <<: *base`);

			return `base: &base {blob: value}\n${mappings.join('\n')}\n`;
		};

		expect(() => parseConfigYaml(repeatedMerges(CONFIG_MAX_COLLECTION_ALIASES), 'roles/editor.yaml')).not.toThrow();

		expect(() => parseConfigYaml(repeatedMerges(CONFIG_MAX_COLLECTION_ALIASES + 1), 'roles/editor.yaml')).toThrow(
			ConfigInvalidException
		);
	});

	it('leaves aliases to scalars unbounded when parsing, including timestamps', () => {
		const refs = (anchor: string) =>
			Array.from({ length: CONFIG_MAX_COLLECTION_ALIASES * 4 }, () => `*${anchor}`).join(', ');

		expect(() => parseConfigYaml(`s: &sv hello\nrefs: [${refs('sv')}]\n`, 'roles/editor.yaml')).not.toThrow();

		const dated = parseConfigYaml(`d: &dv 2024-01-01\nrefs: [${refs('dv')}]\n`, 'roles/editor.yaml') as {
			refs: unknown[];
		};

		expect(dated.refs[0]).toBe('2024-01-01T00:00:00.000Z');
		expect(dated.refs).toHaveLength(CONFIG_MAX_COLLECTION_ALIASES * 4);
	});

	it('rejects a structure far deeper than the bound with a typed error rather than a stack overflow', () => {
		expect(() => assertConfigValueSafe(nest(100_000), 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});
});

describe('assertConfigValueSafe', () => {
	it('rejects a value type that cannot round-trip through storage', () => {
		expect(() => assertConfigValueSafe({ data: new Uint8Array([1]) }, 'roles/editor.yaml')).toThrow(
			ConfigInvalidException
		);

		expect(() => assertConfigValueSafe({ data: new Map() }, 'roles/editor.yaml')).toThrow(ConfigInvalidException);
		expect(() => assertConfigValueSafe({ data: undefined }, 'roles/editor.yaml')).toThrow(ConfigInvalidException);
	});

	it('accepts the JSON value types a permission filter is built from', () => {
		const filter = { _and: [{ status: { _eq: 'published' } }, { score: { _gte: 1.5 } }, { archived: null }] };

		expect(() => assertConfigValueSafe(filter, 'permissions/editor.yaml')).not.toThrow();
	});

	it('leaves its argument untouched', () => {
		const value = { created: new Date('2024-01-01T00:00:00.000Z') };

		assertConfigValueSafe(value, 'roles/editor.yaml');

		expect(value.created).toBeInstanceOf(Date);
	});

	it('names the failing property so an operator can find it', () => {
		let message = '';

		try {
			assertConfigValueSafe({ filter: { _and: [{ score: Number.POSITIVE_INFINITY }] } }, 'permissions/editor.yaml');
		} catch (err) {
			message = (err as Error).message;
		}

		expect(message).toContain('filter._and[0].score');
	});
});
