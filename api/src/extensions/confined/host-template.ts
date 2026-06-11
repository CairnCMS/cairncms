import type { ExtensionCapabilities } from '@cairncms/types';
import { Liquid, type LiquidOptions } from 'liquidjs';
import { ABORTED, abortable, denied, invalidRequest, timedOut } from './host-reply.js';
import type { ConfinedHostReply } from './types.js';

// The render deadline is the API process's per-render event-loop stall budget.
// The engine checks it between template nodes and loop iterations, so the
// honest guarantee is a bounded stall of roughly this long, not responsiveness
// during the render.
export const TEMPLATE_RENDER_LIMIT_MS = 250;

// Cumulative parsed-input length per call. The host-call payload cap is the
// binding transport bound, this is the engine-side backstop.
export const TEMPLATE_PARSE_LIMIT = 1024 * 1024;

// Cumulative per-render allocation budget. Ranges charge their full width up
// front and string builds charge per write, so an expansion bomb trips here
// long before the process feels it.
export const TEMPLATE_MEMORY_LIMIT = 16 * 1024 * 1024;

const MAX_DELIMITER_LENGTH = 8;

const DELIMITER_KEYS = new Set(['tagLeft', 'tagRight', 'outputLeft', 'outputRight']);

// Every lookup path is closed twice over: the loader's directory lists are
// empty, so a partial lookup fails before any read, and the filesystem itself
// denies, so nothing reachable by any future code path reads a file either.
const DENY_FS: NonNullable<LiquidOptions['fs']> = {
	exists: async () => false,
	existsSync: () => false,
	readFile: async () => {
		throw new Error('file access is not available');
	},
	readFileSync: () => {
		throw new Error('file access is not available');
	},
	resolve: (_dir: string, file: string) => file,
	contains: async () => false,
	containsSync: () => false,
	sep: '/',
	dirname: () => '',
};

export interface ConfinedTemplateHostDeps {
	capabilities: ExtensionCapabilities;
	templateOutputBytes: number;
}

type ParsedDelimiters = {
	tagLeft?: string;
	tagRight?: string;
	outputLeft?: string;
	outputRight?: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function readDelimiters(options: unknown): { ok: true; delimiters: ParsedDelimiters } | { ok: false; reason: string } {
	if (options === undefined) return { ok: true, delimiters: {} };
	if (!isPlainObject(options)) return { ok: false, reason: 'the options must be an object' };

	for (const key of Object.keys(options)) {
		if (key !== 'delimiters') return { ok: false, reason: `the option "${key}" is not supported` };
	}

	const delimiters = options['delimiters'];
	if (delimiters === undefined) return { ok: true, delimiters: {} };
	if (!isPlainObject(delimiters)) return { ok: false, reason: 'the delimiters must be an object' };

	const parsed: ParsedDelimiters = {};

	for (const [key, value] of Object.entries(delimiters)) {
		if (!DELIMITER_KEYS.has(key)) return { ok: false, reason: `the delimiter "${key}" is not supported` };

		if (typeof value !== 'string' || value.length === 0 || value.length > MAX_DELIMITER_LENGTH) {
			return { ok: false, reason: 'a delimiter must be a short non-empty string' };
		}

		parsed[key as keyof ParsedDelimiters] = value;
	}

	return { ok: true, delimiters: parsed };
}

function buildEngine(delimiters: ParsedDelimiters): Liquid {
	const options: LiquidOptions = {
		fs: DENY_FS,
		root: [],
		partials: [],
		layouts: [],
		relativeReference: false,
		cache: false,
		parseLimit: TEMPLATE_PARSE_LIMIT,
		renderLimit: TEMPLATE_RENDER_LIMIT_MS,
		memoryLimit: TEMPLATE_MEMORY_LIMIT,
	};

	// The engine silently ignores unknown option keys, so each author option
	// maps explicitly to its engine counterpart. A spread here would make
	// custom delimiters silently inert.
	if (delimiters.tagLeft !== undefined) options.tagDelimiterLeft = delimiters.tagLeft;
	if (delimiters.tagRight !== undefined) options.tagDelimiterRight = delimiters.tagRight;
	if (delimiters.outputLeft !== undefined) options.outputDelimiterLeft = delimiters.outputLeft;
	if (delimiters.outputRight !== undefined) options.outputDelimiterRight = delimiters.outputRight;

	return new Liquid(options);
}

/** One sanitized line, no engine stack and no host detail beyond the engine message. */
function renderFailure(error: unknown): ConfinedHostReply {
	const message = error instanceof Error ? error.message : '';
	const firstLine = message.split('\n', 1)[0]?.slice(0, 160) ?? '';
	return invalidRequest(
		firstLine.length > 0 ? `the template failed to render: ${firstLine}` : 'the template failed to render'
	);
}

export interface ConfinedTemplateHost {
	renderLiquid(args: unknown, signal: AbortSignal): Promise<ConfinedHostReply>;
}

/**
 * Parent-side Liquid rendering with no filesystem reach and the engine's own
 * limiters as the CPU and memory boundary. The instance is constructed per
 * call, so every render carries the deny-fs, empty lookup roots, and limiter
 * configuration, and no state crosses calls.
 */
export function createConfinedTemplateHost(deps: ConfinedTemplateHostDeps): ConfinedTemplateHost {
	return {
		async renderLiquid(args, signal) {
			if (deps.capabilities.template !== true) return denied('the template capability is not declared');
			if (signal.aborted) return timedOut();

			const record = args !== null && typeof args === 'object' ? (args as Record<string, unknown>) : {};

			const template = record['template'];
			if (typeof template !== 'string') return invalidRequest('the template must be a string');

			const data = record['data'];
			if (data !== undefined && !isPlainObject(data)) return invalidRequest('the data must be an object');

			const delimiters = readDelimiters(record['options']);
			if (!delimiters.ok) return invalidRequest(delimiters.reason);

			let output: string;

			try {
				const engine = buildEngine(delimiters.delimiters);
				const result = await abortable(engine.parseAndRender(template, data ?? {}), signal);
				if (result === ABORTED) return timedOut();
				output = String(result);
			} catch (error) {
				return renderFailure(error);
			}

			// The surface cap bounds the serialized reply value, so passing here
			// guarantees passing the chokepoint.
			if (Buffer.byteLength(JSON.stringify(output), 'utf8') > deps.templateOutputBytes) {
				return invalidRequest('the template output exceeds the reply cap');
			}

			return { ok: true, value: output };
		},
	};
}
