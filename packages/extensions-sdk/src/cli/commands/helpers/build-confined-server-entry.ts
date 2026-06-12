import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { build, context, type BuildFailure, type BuildOptions } from 'esbuild';

export class ConfinedBuildError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ConfinedBuildError';
	}
}

export type ConfinedGuestGlobal = 'CairnOperation' | 'CairnEndpoint';

export interface BuildConfinedServerEntryOptions {
	// The server entry source: an ESM module with a default-exported confined config.
	input: string;
	// The package root every bundled file must be accounted to.
	root: string;
	// When set, the built entry is written here. The built code is always returned.
	output?: string;
	// The guest contract global the IIFE exposes. Defaults to the operation contract.
	globalName?: ConfinedGuestGlobal;
}

function isBuildFailure(error: unknown): error is BuildFailure {
	return error !== null && typeof error === 'object' && Array.isArray((error as { errors?: unknown }).errors);
}

/**
 * Reduces an esbuild failure to author-facing messages, without absolute paths
 * or stacks. An unresolved import or a Node builtin surfaces as
 * `Could not resolve ...`.
 */
function sanitizeBuildError(error: unknown): string {
	if (isBuildFailure(error)) {
		const messages = error.errors.map((problem) => problem.text).filter((text) => text.length > 0);
		if (messages.length > 0) return messages.join('; ');
	}

	return 'the confined server entry could not be built';
}

/**
 * Refuses any bundled input the validator cannot account for. An input passes
 * only when its real path is inside the real package root, or still under a
 * node_modules segment after resolution (every genuine store layout keeps one,
 * while a file:, link:, workspace:, or npm-link dependency resolves to a bare
 * local directory the scanner never reads). Directory position is not trust,
 * the resolved destination is.
 */
async function assertContained(inputs: string[], rootAbs: string, realRoot: string): Promise<void> {
	for (const inputPath of inputs) {
		let real: string;

		try {
			real = await realpath(resolve(rootAbs, inputPath));
		} catch {
			throw new ConfinedBuildError(`the bundled file "${inputPath}" could not be resolved on disk`);
		}

		const fromRoot = relative(realRoot, real);
		const inside = fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot);
		if (inside) continue;

		if (real.split(sep).includes('node_modules')) continue;

		throw new ConfinedBuildError(`the bundled file "${inputPath}" resolves outside the package root`);
	}
}

/**
 * Builds a confined server entry into the self-contained artifact the confined
 * engine evaluates: an esbuild IIFE bundle exposing the contract's global
 * (`CairnOperation` or `CairnEndpoint`) whose module exports
 * `{ default: { id, handler } }`.
 *
 * `platform: 'neutral'` means Node builtins are not auto-externalized, so a `node:`
 * import is unresolved and fails the build. There are no externals, so any
 * unresolved import fails the build too. The result is fully self-contained, with the
 * pure `@cairncms/extensions-server-api` bundled away as an identity helper. The
 * settings are deterministic (no banners, license comments, or charset escapes, and
 * paths anchored to the package root rather than the working directory) so the
 * output is byte-stable for an on-disk drift check. Every bundled input is then
 * containment-checked against the root, so the build cannot include local source
 * the validator would never scan. Build failures surface as a sanitized
 * `ConfinedBuildError` suitable for an extension author.
 */
export async function buildConfinedServerEntry(options: BuildConfinedServerEntryOptions): Promise<{ code: string }> {
	const rootAbs = resolve(options.root);
	const realRoot = await resolveRealRoot(rootAbs);

	let result;

	try {
		result = await build(confinedEsbuildOptions(rootAbs, options.input, options.globalName));
	} catch (error) {
		throw new ConfinedBuildError(sanitizeBuildError(error));
	}

	await assertContained(Object.keys(result.metafile?.inputs ?? {}), rootAbs, realRoot);

	const file = result.outputFiles?.[0];
	if (file === undefined) throw new ConfinedBuildError('the confined server entry produced no output');

	if (options.output !== undefined) {
		await writeOutput(rootAbs, options.output, file.contents);
	}

	return { code: file.text };
}

export interface WatchConfinedServerEntryOptions {
	input: string;
	root: string;
	// The artifact must land on disk every rebuild, so output is required in watch.
	output: string;
	globalName?: ConfinedGuestGlobal;
	onRebuild: (result: { ok: true } | { ok: false; message: string }) => void;
}

/**
 * The watch-mode counterpart: the same option set and the same containment and
 * write pipeline, run on every rebuild through an esbuild context, with each
 * outcome reported as a sanitized result. The first callback fires for the
 * initial build.
 */
export async function watchConfinedServerEntry(
	options: WatchConfinedServerEntryOptions
): Promise<{ close: () => Promise<void> }> {
	const rootAbs = resolve(options.root);
	const realRoot = await resolveRealRoot(rootAbs);

	const watcher = await context({
		...confinedEsbuildOptions(rootAbs, options.input, options.globalName),
		plugins: [
			{
				name: 'confined-containment',
				setup(build) {
					build.onEnd(async (result) => {
						if (result.errors.length > 0) {
							options.onRebuild({ ok: false, message: sanitizeBuildError({ errors: result.errors }) });
							return;
						}

						try {
							await assertContained(Object.keys(result.metafile?.inputs ?? {}), rootAbs, realRoot);

							const file = result.outputFiles?.[0];
							if (file === undefined) throw new ConfinedBuildError('the confined server entry produced no output');

							await writeOutput(rootAbs, options.output, file.contents);
						} catch (error) {
							options.onRebuild({
								ok: false,
								message:
									error instanceof ConfinedBuildError ? error.message : 'the confined server entry could not be built',
							});

							return;
						}

						options.onRebuild({ ok: true });
					});
				},
			},
		],
	});

	await watcher.watch();

	return { close: () => watcher.dispose() };
}

function confinedEsbuildOptions(
	rootAbs: string,
	input: string,
	globalName: ConfinedGuestGlobal = 'CairnOperation'
): BuildOptions & { write: false; metafile: true } {
	return {
		entryPoints: [resolve(rootAbs, input)],
		absWorkingDir: rootAbs,
		bundle: true,
		format: 'iife',
		globalName,
		platform: 'neutral',
		target: 'es2022',
		legalComments: 'none',
		charset: 'utf8',
		logLevel: 'silent',
		write: false,
		metafile: true,
	};
}

async function resolveRealRoot(rootAbs: string): Promise<string> {
	try {
		return await realpath(rootAbs);
	} catch {
		throw new ConfinedBuildError('the package root could not be resolved on disk');
	}
}

async function writeOutput(rootAbs: string, output: string, contents: Uint8Array): Promise<void> {
	const outputAbs = resolve(rootAbs, output);

	try {
		await mkdir(dirname(outputAbs), { recursive: true });
		await writeFile(outputAbs, contents);
	} catch {
		throw new ConfinedBuildError('the built entry could not be written to the output path');
	}
}
