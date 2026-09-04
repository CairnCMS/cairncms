import { load as loadYaml, YAMLException, type LoadOptions } from 'js-yaml';
import { isPlainObject } from 'lodash-es';
import { ConfigInvalidException } from '../exceptions/config-invalid.js';
import { safeLogFragment } from './safe-log-fragment.js';

/**
 * Root value is depth 0 and every object or array level adds 1.
 * Serialization starts failing near 1,100, and the deepest document the platform produces is 10.
 */
export const CONFIG_MAX_DEPTH = 100;

/**
 * Repeat references to one collection per document, matching SnakeYAML's `maxAliasesForCollections`.
 * Expansion multiplies stored size, not authored size: 266 bytes six levels deep expands to 42 MB.
 * Enforced twice, since neither place sees every form: while parsing, where merge keys are still
 * visible, and again over the parsed tree, which covers structures shared without going through YAML.
 * Scalar aliases stay unbounded, matching the SnakeYAML precedent. They still lengthen output, but
 * only in proportion to their use, where a collection graph compounds with every level.
 */
export const CONFIG_MAX_COLLECTION_ALIASES = 50;

/** The installed `@types/js-yaml` predates the `maxDepth` option. */
type ConfigLoadOptions = LoadOptions & { maxDepth: number };

/**
 * The parser's `maxDepth` is raised above the engine's own `CONFIG_MAX_DEPTH` so the diagnostic an
 * operator sees names the engine bound. `maxDepth` counts two levels more than `CONFIG_MAX_DEPTH` for
 * the same document.
 */
const LOADER_OPTIONS: ConfigLoadOptions = {
	maxDepth: CONFIG_MAX_DEPTH * 2,
};

/**
 * Counts collection aliases during parsing, which is the only place merges are still visible. The
 * parser flattens merge keys into their target, so `<<: *base` repeated across many mappings leaves
 * no reference behind for the walk below to find, and each statement holds a single alias that no
 * sequence-length limit reaches. Left uncounted, 12 KB of such mappings serializes to 1 MB.
 *
 * A collection closes more than once only when an alias references it, so repeat closes are the
 * resolution count. Collections are identified exactly as the walk below identifies them, since a
 * timestamp is an object too and aliasing one must stay free.
 */
function countCollectionAliases(label: string): NonNullable<LoadOptions['listener']> {
	const seen = new Set<object>();
	let resolutions = 0;

	return function (event, state) {
		if (event !== 'close') return;

		const result: unknown = state.result;
		if (!Array.isArray(result) && !isPlainObject(result)) return;

		const collection = result as object;

		if (!seen.has(collection)) {
			seen.add(collection);
			return;
		}

		resolutions++;

		if (resolutions > CONFIG_MAX_COLLECTION_ALIASES) {
			throw new ConfigInvalidException(
				describe(label, '', `more than ${CONFIG_MAX_COLLECTION_ALIASES} repeated references to a collection`)
			);
		}
	};
}

type Frame = {
	value: unknown;
	depth: number;
	path: string;
	parent: Record<string, unknown> | unknown[] | undefined;
	key: string | number | undefined;
	leaving: boolean;
};

function describe(label: string, path: string, detail: string): string {
	const where = path === '' ? '' : ` at "${safeLogFragment(path)}"`;
	return `Config document "${safeLogFragment(label)}"${where} is invalid: ${detail}.`;
}

function typeName(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value !== 'object') return typeof value;
	return value.constructor?.name ?? 'object';
}

/**
 * Cycles are checked against the ancestor chain, since one collection may be referenced from several
 * places without being a cycle.
 *
 * A repeated collection is re-walked at each position rather than skipped as already-checked.
 * Snapshots serialize aliases expanded, so a subtree that is shallow at one position and deep at
 * another must be measured at the deep one, or the document would serialize into output this parser
 * rejects. Every repeat spends alias budget, which bounds the re-walking.
 */
function walkConfigValue(root: unknown, label: string, normalize: boolean): unknown {
	if (root instanceof Date) return normalize ? root.toISOString() : root;

	const ancestors = new Set<object>();
	const seen = new Set<object>();
	let aliasEncounters = 0;

	const stack: Frame[] = [{ value: root, depth: 0, path: '', parent: undefined, key: undefined, leaving: false }];

	while (stack.length > 0) {
		const frame = stack.pop()!;

		if (frame.leaving) {
			ancestors.delete(frame.value as object);
			continue;
		}

		const { value, depth, path, parent, key } = frame;

		if (depth > CONFIG_MAX_DEPTH) {
			throw new ConfigInvalidException(
				describe(label, path, `nesting is deeper than the supported limit of ${CONFIG_MAX_DEPTH}`)
			);
		}

		if (value === null || typeof value === 'string' || typeof value === 'boolean') continue;

		if (typeof value === 'number') {
			if (!Number.isFinite(value)) {
				throw new ConfigInvalidException(describe(label, path, `${typeName(value)} ${value} cannot be stored`));
			}

			continue;
		}

		if (value instanceof Date) {
			if (normalize && parent !== undefined && key !== undefined) {
				(parent as Record<string | number, unknown>)[key] = value.toISOString();
			}

			continue;
		}

		const isArray = Array.isArray(value);

		if (!isArray && !isPlainObject(value)) {
			throw new ConfigInvalidException(describe(label, path, `values of type ${typeName(value)} are not supported`));
		}

		const container = value as object;

		if (ancestors.has(container)) {
			throw new ConfigInvalidException(describe(label, path, 'the document references itself'));
		}

		if (seen.has(container)) {
			aliasEncounters++;

			if (aliasEncounters > CONFIG_MAX_COLLECTION_ALIASES) {
				throw new ConfigInvalidException(
					describe(label, path, `more than ${CONFIG_MAX_COLLECTION_ALIASES} repeated references to a collection`)
				);
			}
		} else {
			seen.add(container);
		}

		ancestors.add(container);
		stack.push({ ...frame, leaving: true });

		if (isArray) {
			const items = value as unknown[];

			for (let index = items.length - 1; index >= 0; index--) {
				stack.push({
					value: items[index],
					depth: depth + 1,
					path: `${path}[${index}]`,
					parent: items,
					key: index,
					leaving: false,
				});
			}

			continue;
		}

		const entries = Object.entries(value as Record<string, unknown>);

		for (let index = entries.length - 1; index >= 0; index--) {
			const [entryKey, entryValue] = entries[index]!;

			stack.push({
				value: entryValue,
				depth: depth + 1,
				path: path === '' ? entryKey : `${path}.${entryKey}`,
				parent: value as Record<string, unknown>,
				key: entryKey,
				leaving: false,
			});
		}
	}

	return root;
}

/** Asserts a value stores and round-trips without silent change, leaving it untouched. */
export function assertConfigValueSafe(value: unknown, label: string): void {
	walkConfigValue(value, label, false);
}

/**
 * Parses one YAML config document, normalizing timestamps to ISO strings.
 *
 * Errors carry the parser's reason and position, never its message, which quotes the source line and
 * would copy an adjacent secret into a diagnostic. `json: true` must stay off, since it accepts
 * duplicate keys and silently keeps the last.
 */
export function parseConfigYaml(source: string, label: string): unknown {
	let loaded: unknown;

	try {
		loaded = loadYaml(source, { ...LOADER_OPTIONS, listener: countCollectionAliases(label) });
	} catch (err) {
		if (err instanceof YAMLException) {
			const position =
				typeof err.mark?.line === 'number' ? ` at line ${err.mark.line + 1}, column ${err.mark.column + 1}` : '';

			throw new ConfigInvalidException(
				`Config document "${safeLogFragment(label)}" could not be parsed${position}: ${safeLogFragment(err.reason)}.`
			);
		}

		throw err;
	}

	if (loaded === undefined) {
		throw new ConfigInvalidException(`Config document "${safeLogFragment(label)}" is empty.`);
	}

	return walkConfigValue(loaded, label, true);
}
