import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { realEntryInsideRoot } from './entry-integrity.js';
import type { ExtensionValidationReason, ExtensionValidationReasonCode } from '../validation.js';
import type { LocalExtensionCandidate } from './types.js';

/**
 * Conservative lexical scanner. It reads local source files, follows only the
 * package's own relative imports, and classifies external specifiers by string.
 * It never resolves external dependencies, requires node_modules, runs a build,
 * or imports extension code. Textual false positives are acceptable: they
 * downgrade rather than under-flag.
 */

const RAW_FS = new Set(['fs', 'fs/promises']);
const RAW_NETWORK_BUILTINS = new Set(['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns']);
const CHILD_PROCESS = new Set(['child_process']);

const NODE_BUILTINS = new Set([
	'assert',
	'async_hooks',
	'buffer',
	'child_process',
	'cluster',
	'console',
	'constants',
	'crypto',
	'dgram',
	'diagnostics_channel',
	'dns',
	'domain',
	'events',
	'fs',
	'fs/promises',
	'http',
	'http2',
	'https',
	'inspector',
	'module',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'punycode',
	'querystring',
	'readline',
	'repl',
	'stream',
	'string_decoder',
	'sys',
	'timers',
	'tls',
	'trace_events',
	'tty',
	'url',
	'util',
	'v8',
	'vm',
	'wasi',
	'worker_threads',
	'zlib',
]);

const RAW_NETWORK_PACKAGES = new Set([
	'axios',
	'node-fetch',
	'got',
	'undici',
	'superagent',
	'request',
	'phin',
	'needle',
]);

const PUBLIC_CAIRNCMS = new Set(['@cairncms/extensions-server-api']);

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function classifyExternalSpecifier(specifier: string): ExtensionValidationReasonCode | null {
	const base = specifier.startsWith('node:') ? specifier.slice(5) : specifier;

	if (specifier.startsWith('node:') || NODE_BUILTINS.has(base)) {
		if (RAW_FS.has(base)) return 'uses-raw-fs';
		if (RAW_NETWORK_BUILTINS.has(base)) return 'uses-raw-network';
		if (CHILD_PROCESS.has(base)) return 'uses-child-process';
		return 'uses-node-builtin';
	}

	if (specifier === '@cairncms/extensions-sdk') return 'uses-legacy-sdk-runtime-import';
	if (PUBLIC_CAIRNCMS.has(specifier)) return null;
	if (specifier.startsWith('@cairncms/')) return 'uses-internal-cairncms-import';

	const scope = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
	if (RAW_NETWORK_PACKAGES.has(specifier) || (scope !== undefined && RAW_NETWORK_PACKAGES.has(scope)))
		return 'uses-raw-network';

	return null;
}

type TextScan = {
	specifiers: string[];
	dynamicRequire: boolean;
	dynamicImport: boolean;
	dynamicCode: boolean;
	usesEnv: boolean;
	usesRawNetwork: boolean;
};

// Matches an `import(` or `require(` call whose argument is not a single clean
// string literal: an identifier, a concatenation, a template literal, or an
// empty call. Static classification can only follow plain-string specifiers, so
// any computed specifier must downgrade rather than slip past the by-string
// import checks. The negative lookahead fails the call only when the argument is
// exactly one quoted string that closes the call.
const NON_LITERAL_CALL_ARG = '\\(\\s*(?![\'"][^\'"]*[\'"]\\s*\\))';

// Keywords after which a `/` begins a regular expression literal rather than a
// division operator.
const REGEX_PRECEDING_KEYWORDS = new Set([
	'return',
	'typeof',
	'instanceof',
	'in',
	'of',
	'do',
	'else',
	'yield',
	'await',
	'case',
	'delete',
	'void',
	'new',
	'throw',
]);

/**
 * The identifier run at the end of the already-emitted output, ignoring trailing
 * whitespace. Walks back a bounded number of characters, so it stays cheap.
 */
function trailingIdentifier(out: string): string {
	let end = out.length;
	while (end > 0 && /\s/.test(out[end - 1]!)) end -= 1;
	let start = end;
	while (start > 0 && /[A-Za-z0-9_$]/.test(out[start - 1]!)) start -= 1;
	return out.slice(start, end);
}

/**
 * Decides whether a `/` begins a regex literal from the last significant token.
 * A value-ending token (`)`, `]`, or a non-keyword identifier) reads as division,
 * otherwise as a regex. This is a heuristic, not a parser, so a lone `/` in a
 * rare construct can be misjudged.
 */
function startsRegexLiteral(out: string): boolean {
	let end = out.length;
	while (end > 0 && /\s/.test(out[end - 1]!)) end -= 1;
	if (end === 0) return true;
	const last = out[end - 1]!;
	if (last === ')' || last === ']') return false;
	if (/[A-Za-z0-9_$]/.test(last)) return REGEX_PRECEDING_KEYWORDS.has(trailingIdentifier(out));
	return true;
}

/**
 * Returns the source with comments replaced by a single space, preserving the
 * contents of string literals, template literal string parts, and regex
 * literals. Comments inside template interpolation (`${ ... }`) are stripped
 * because those expressions are executable code. Without this a comment could
 * split an `import`/`require` token from its call parenthesis (or `process` from
 * `.env`) and slip past the call matchers. A removed comment can only reduce
 * matches on non-executable text, never hide executable code, so it stays
 * downgrade-safe. This is a lexical pass, not a parser: it tracks strings,
 * template interpolation depth, and regex literals, and aims to fail toward
 * downgrade rather than to be a complete deobfuscator.
 */
function stripComments(text: string): string {
	let out = '';
	let i = 0;
	const n = text.length;
	// One entry per open template literal: the brace depth of the `${ }`
	// expression being read, or -1 while reading that template's string part. An
	// empty stack means ordinary code.
	const templates: number[] = [];

	while (i < n) {
		const depth = templates.length > 0 ? templates[templates.length - 1]! : null;
		const c = text[i]!;
		const c2 = i + 1 < n ? text[i + 1]! : '';

		if (depth === -1) {
			if (c === '\\') {
				out += text.slice(i, i + 2);
				i += 2;
			} else if (c === '`') {
				out += c;
				templates.pop();
				i += 1;
			} else if (c === '$' && c2 === '{') {
				out += '${';
				templates[templates.length - 1] = 0;
				i += 2;
			} else {
				out += c;
				i += 1;
			}

			continue;
		}

		if (c === '/' && c2 === '/') {
			out += ' ';
			i += 2;
			while (i < n && text[i] !== '\n') i += 1;
		} else if (c === '/' && c2 === '*') {
			out += ' ';
			i += 2;
			while (i < n && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
			i += 2;
		} else if (c === "'" || c === '"') {
			out += c;
			i += 1;

			while (i < n) {
				const d = text[i]!;

				if (d === '\\') {
					out += text.slice(i, i + 2);
					i += 2;
					continue;
				}

				out += d;
				i += 1;
				if (d === c) break;
			}
		} else if (c === '`') {
			out += c;
			templates.push(-1);
			i += 1;
		} else if (c === '/' && startsRegexLiteral(out)) {
			out += c;
			i += 1;
			let inClass = false;

			while (i < n) {
				const d = text[i]!;

				if (d === '\\') {
					out += text.slice(i, i + 2);
					i += 2;
					continue;
				}

				out += d;
				i += 1;
				if (d === '[') inClass = true;
				else if (d === ']') inClass = false;
				else if (d === '\n') break;
				else if (d === '/' && !inClass) break;
			}
		} else if (depth !== null && depth >= 0 && c === '{') {
			templates[templates.length - 1] = depth + 1;
			out += c;
			i += 1;
		} else if (depth !== null && depth >= 0 && c === '}') {
			templates[templates.length - 1] = depth === 0 ? -1 : depth - 1;
			out += c;
			i += 1;
		} else {
			out += c;
			i += 1;
		}
	}

	return out;
}

function scanText(text: string): TextScan {
	const source = stripComments(text);
	const specifiers: string[] = [];

	const patterns = [
		/\bfrom\s*['"]([^'"]+)['"]/g,
		/\bimport\s*['"]([^'"]+)['"]/g,
		/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
		/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
	];

	for (const pattern of patterns) {
		let match: RegExpExecArray | null;

		while ((match = pattern.exec(source)) !== null) {
			if (match[1]) specifiers.push(match[1]);
		}
	}

	return {
		specifiers,
		dynamicRequire: new RegExp(`\\brequire\\s*${NON_LITERAL_CALL_ARG}`).test(source),
		dynamicImport: new RegExp(`\\bimport\\s*${NON_LITERAL_CALL_ARG}`).test(source),
		dynamicCode: /\beval\s*\(|\bnew\s+Function\s*\(/.test(source),
		usesEnv: /\bprocess\s*\.\s*env\b/.test(source),
		// A raw ambient `fetch(` call, or `globalThis`/`self`/`window.fetch(`. The
		// negative lookbehind skips a member call like `client.fetch(`, which is not the
		// global. Outbound HTTP must go through `host.request.send`.
		usesRawNetwork:
			/(?<![\w$.])fetch\s*\(/.test(source) || /\b(?:globalThis|self|window)\s*\.\s*fetch\s*\(/.test(source),
	};
}

async function resolveLocalImport(fromFile: string, specifier: string): Promise<string | null> {
	const base = path.resolve(path.dirname(fromFile), specifier);

	const candidates = [
		base,
		...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
		...SOURCE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`)),
	];

	for (const candidate of candidates) {
		try {
			if ((await stat(candidate)).isFile()) return candidate;
		} catch {
			// not this candidate
		}
	}

	return null;
}

async function collectSourceFiles(
	candidate: LocalExtensionCandidate
): Promise<{ files: string[]; reasons: ExtensionValidationReason[] }> {
	const files: string[] = [];

	for (const relativePath of candidate.entries) {
		const real = await realEntryInsideRoot(candidate.root, relativePath);
		if (real !== null) files.push(real);
	}

	if (files.length === 0) {
		return {
			files,
			reasons: [{ code: 'source-unavailable', message: 'no readable source or entry files were found to analyze' }],
		};
	}

	return { files, reasons: [] };
}

/**
 * Scans the candidate's local source graph and returns deduplicated validation
 * reasons (one per code, with a representative file path and no source snippet)
 * plus the entry/source files that were resolved.
 */
export async function scanCandidateSource(
	candidate: LocalExtensionCandidate
): Promise<{ reasons: ExtensionValidationReason[]; sourceFiles: string[] }> {
	const { files, reasons: collectReasons } = await collectSourceFiles(candidate);
	const reasons = new Map<ExtensionValidationReasonCode, ExtensionValidationReason>();

	for (const reason of collectReasons) reasons.set(reason.code, reason);

	const visited = new Set<string>();
	const inspected = new Set<string>();
	const queue = [...files];

	const add = (code: ExtensionValidationReasonCode, file: string): void => {
		if (!reasons.has(code)) reasons.set(code, { code, message: `detected in ${path.relative(candidate.root, file)}` });
	};

	while (queue.length > 0) {
		const file = queue.shift();
		if (file === undefined || visited.has(file)) continue;
		visited.add(file);

		let text: string;

		try {
			text = await readFile(file, 'utf8');
		} catch {
			continue;
		}

		inspected.add(file);

		const scan = scanText(text);

		if (scan.usesEnv) add('uses-raw-env', file);
		if (scan.usesRawNetwork) add('uses-raw-network', file);
		if (scan.dynamicRequire) add('uses-dynamic-require', file);
		if (scan.dynamicImport) add('uses-dynamic-import', file);
		if (scan.dynamicCode) add('uses-dynamic-code', file);

		for (const specifier of scan.specifiers) {
			if (specifier.startsWith('.')) {
				const resolved = await resolveLocalImport(file, specifier);

				if (resolved !== null) {
					const real = await realEntryInsideRoot(candidate.root, resolved);
					if (real !== null) queue.push(real);
				}
			} else {
				const code = classifyExternalSpecifier(specifier);
				if (code !== null) add(code, file);
			}
		}
	}

	return { reasons: [...reasons.values()], sourceFiles: [...inspected] };
}
