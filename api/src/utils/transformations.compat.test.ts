import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Sharp } from 'sharp';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { File } from '../types/index.js';
import { TransformationMethods } from '../types/assets.js';
import { resolvePreset } from './transformations.js';

const allowlistArgs: Record<string, (t: Sharp) => Sharp> = {
	toFormat: (t) => t.toFormat('png'),
	jpeg: (t) => t.jpeg({ quality: 80 }),
	png: (t) => t.png({ compressionLevel: 6 }),
	tiff: (t) => t.tiff({ quality: 80 }),
	webp: (t) => t.webp({ quality: 80 }),
	avif: (t) => t.avif({ quality: 50 }),
	resize: (t) => t.resize(32, 20),
	extend: (t) => t.extend({ top: 4, bottom: 4, left: 4, right: 4 }),
	extract: (t) => t.extract({ left: 2, top: 2, width: 20, height: 12 }),
	trim: (t) => t.trim(),
	rotate: (t) => t.rotate(90),
	flip: (t) => t.flip(),
	flop: (t) => t.flop(),
	sharpen: (t) => t.sharpen(),
	median: (t) => t.median(3),
	blur: (t) => t.blur(2),
	flatten: (t) => t.flatten({ background: '#ffffff' }),
	gamma: (t) => t.gamma(2.2),
	negate: (t) => t.negate(),
	normalise: (t) => t.normalise(),
	normalize: (t) => t.normalize(),
	clahe: (t) => t.clahe({ width: 3, height: 3 }),
	convolve: (t) => t.convolve({ width: 3, height: 3, kernel: [0, 0, 0, 0, 1, 0, 0, 0, 0] }),
	threshold: (t) => t.threshold(128),
	linear: (t) => t.linear(1, 0),
	recomb: (t) =>
		t.recomb([
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 1],
		]),
	modulate: (t) => t.modulate({ brightness: 1.1 }),
	tint: (t) => t.tint('#ff0000'),
	greyscale: (t) => t.greyscale(),
	grayscale: (t) => t.grayscale(),
	toColorspace: (t) => t.toColorspace('srgb'),
	toColourspace: (t) => t.toColourspace('srgb'),
	removeAlpha: (t) => t.removeAlpha(),
	ensureAlpha: (t) => t.ensureAlpha(),
	extractChannel: (t) => t.extractChannel(0),
	bandbool: (t) => t.bandbool('and'),
};

// Chainable sharp methods a preset can invoke beyond the allowlist, enumerated with
// the same terminal the asset service uses (no forced output format). composite,
// boolean, and joinChannel take an operand image the preset carries as a path, so the
// operand here is a temporary file. A text-input composite exercises native text
// rendering, a documented WebAssembly limitation. jxl is excluded because its save is
// unavailable in the bundled libvips. Output-format methods carry their reported
// format so a later forced encode cannot mask a regression.
type BaselineCase = { apply: (t: Sharp, operandPath: string) => Sharp; format?: string };

const presetBaselineArgs: Record<string, BaselineCase> = {
	affine: {
		apply: (t) =>
			t.affine([
				[1, 0],
				[0, 1],
			]),
	},
	clone: { apply: (t) => t.clone() },
	tile: { apply: (t) => t.tile({}), format: 'dz' },
	composite: { apply: (t, operandPath) => t.composite([{ input: operandPath, blend: 'over' }]) },
	'composite text': { apply: (t) => t.composite([{ input: { text: { text: 'compat', width: 20, height: 10 } } }]) },
	boolean: { apply: (t, operandPath) => t.boolean(operandPath, 'and') },
	joinChannel: { apply: (t, operandPath) => t.joinChannel(operandPath) },
	gif: { apply: (t) => t.gif(), format: 'gif' },
	heif: { apply: (t) => t.heif({ compression: 'av1' }), format: 'heif' },
	raw: { apply: (t) => t.raw(), format: 'raw' },
	keepExif: { apply: (t) => t.keepExif() },
	keepIccProfile: { apply: (t) => t.keepIccProfile() },
	keepMetadata: { apply: (t) => t.keepMetadata() },
	pipelineColorspace: { apply: (t) => t.pipelineColorspace('rgb16') },
	pipelineColourspace: { apply: (t) => t.pipelineColourspace('rgb16') },
	timeout: { apply: (t) => t.timeout({ seconds: 5 }) },
	unflatten: { apply: (t) => t.unflatten() },
	withExif: { apply: (t) => t.withExif({}) },
	withExifMerge: { apply: (t) => t.withExifMerge({}) },
	withIccProfile: { apply: (t) => t.withIccProfile('srgb') },
	withMetadata: { apply: (t) => t.withMetadata() },
};

const transformFormats = ['jpeg', 'png', 'webp', 'tiff', 'avif'] as const;
const reportedFormat: Record<string, string> = { avif: 'heif', jpeg: 'jpeg', png: 'png', webp: 'webp', tiff: 'tiff' };

// A forced-WASM run sets SHARP_COMPAT_BACKEND=wasm. tile (deep-zoom dzsave) and
// text-composite rendering are the two documented limitations of the WASM fallback.
// Native Sharp supports both. An unrecognized value throws so a misspelled backend
// cannot become a native false pass.
const backendEnv = process.env['SHARP_COMPAT_BACKEND'];

if (backendEnv !== undefined && backendEnv !== 'native' && backendEnv !== 'wasm') {
	throw new Error(`SHARP_COMPAT_BACKEND must be "native" or "wasm", received "${backendEnv}"`);
}

const backend: 'native' | 'wasm' = backendEnv === 'wasm' ? 'wasm' : 'native';

const wasmUnavailable: Record<string, RegExp> = {
	tile: /dzsave_buffer/,
	'composite text': /class "text"/,
};

function makeInput(): Promise<Buffer> {
	return sharp({ create: { width: 40, height: 24, channels: 4, background: { r: 200, g: 90, b: 40, alpha: 1 } } })
		.png()
		.toBuffer();
}

async function pixel(buffer: Buffer, x: number, y: number, width: number, channels: number): Promise<number[]> {
	const raw = await sharp(buffer).raw().toBuffer();
	const offset = (y * width + x) * channels;
	return [raw[offset]!, raw[offset + 1]!, raw[offset + 2]!];
}

describe('sharp transform compatibility', () => {
	let operandDir: string;
	let operandPath: string;

	beforeAll(async () => {
		operandDir = mkdtempSync(join(tmpdir(), 'sharp-compat-'));
		operandPath = join(operandDir, 'operand.png');
		writeFileSync(operandPath, await makeInput());
	});

	afterAll(() => {
		rmSync(operandDir, { recursive: true, force: true });
	});

	test('bundles exactly libvips 8.18.3', () => {
		expect(sharp.versions.vips).toBe('8.18.3');
	});

	test(`runs on the ${backend} backend`, () => {
		expect('emscripten' in sharp.versions).toBe(backend === 'wasm');
	});

	test('every allowlisted method has a compatibility case', () => {
		for (const method of TransformationMethods) {
			expect(allowlistArgs[method], `missing compatibility case for "${method}"`).toBeDefined();
		}
	});

	test.each(TransformationMethods)('allowlisted method "%s" produces valid output', async (method) => {
		const input = await makeInput();
		const output = await allowlistArgs[method]!(sharp(input)).png().toBuffer();
		const metadata = await sharp(output).metadata();
		expect(metadata.width).toBeGreaterThan(0);
		expect(metadata.height).toBeGreaterThan(0);
	});

	test.each(Object.keys(presetBaselineArgs))(
		'preset-invokable method "%s" produces valid output or a documented WASM limitation',
		async (method) => {
			const input = await makeInput();
			const { apply, format } = presetBaselineArgs[method]!;

			if (backend === 'wasm' && wasmUnavailable[method]) {
				await expect(apply(sharp(input), operandPath).toBuffer()).rejects.toThrow(wasmUnavailable[method]!);
				return;
			}

			const transformer = sharp(input);
			apply(transformer, operandPath);
			const { data, info } = await transformer.toBuffer({ resolveWithObject: true });

			expect(data.length).toBeGreaterThan(0);
			if (format) expect(info.format).toBe(format);
		}
	);

	test.each(transformFormats.flatMap((from) => transformFormats.map((to) => [from, to] as const)))(
		'transforms %s input to %s output',
		async (from, to) => {
			const base = await makeInput();
			const encoded = await sharp(base)[from]().toBuffer();
			const output = await sharp(encoded).toFormat(to).toBuffer();
			const metadata = await sharp(output).metadata();
			expect(metadata.format).toBe(reportedFormat[to]);
		}
	);

	test('reads metadata for gif (metadata-only input)', async () => {
		const gif = await sharp(await makeInput())
			.gif()
			.toBuffer();

		const metadata = await sharp(gif).metadata();
		expect(metadata.format).toBe('gif');
		expect(metadata.width).toBe(40);
	});

	test('resize sets the requested dimensions', async () => {
		const output = await sharp(await makeInput())
			.resize(20, 10)
			.png()
			.toBuffer();

		const metadata = await sharp(output).metadata();
		expect([metadata.width, metadata.height]).toEqual([20, 10]);
	});

	test('rotate by 90 swaps width and height', async () => {
		const output = await sharp(await makeInput())
			.rotate(90)
			.png()
			.toBuffer();

		const metadata = await sharp(output).metadata();
		expect([metadata.width, metadata.height]).toEqual([24, 40]);
	});

	test('extend grows the canvas by the requested margins', async () => {
		const output = await sharp(await makeInput())
			.extend({ top: 4, bottom: 4, left: 4, right: 4 })
			.png()
			.toBuffer();

		const metadata = await sharp(output).metadata();
		expect([metadata.width, metadata.height]).toEqual([48, 32]);
	});

	test('extract crops to the requested region', async () => {
		const output = await sharp(await makeInput())
			.extract({ left: 2, top: 2, width: 20, height: 12 })
			.png()
			.toBuffer();

		const metadata = await sharp(output).metadata();
		expect([metadata.width, metadata.height]).toEqual([20, 12]);
	});

	test('grayscale removes chroma so channels are equal', async () => {
		const output = await sharp(await makeInput())
			.grayscale()
			.png()
			.toBuffer();

		const [r, g, b] = await pixel(output, 10, 10, 40, 4);
		expect(r).toBe(g);
		expect(g).toBe(b);
	});

	test('negate inverts pixel values', async () => {
		const input = await makeInput();
		const [r0, g0, b0] = await pixel(input, 10, 10, 40, 4);
		const output = await sharp(input).negate().png().toBuffer();
		const [r1, g1, b1] = await pixel(output, 10, 10, 40, 4);
		expect(r1).toBe(255 - r0!);
		expect(g1).toBe(255 - g0!);
		expect(b1).toBe(255 - b0!);
	});

	test('format=jpg keeps the jpg tuple for the cache key and emits jpeg output', async () => {
		const file = { type: 'image/png' } as File;
		const transforms = resolvePreset({ transformationParams: { format: 'jpg' } }, file);

		expect(transforms).toContainEqual(['toFormat', 'jpg', { quality: undefined }]);

		const input = await makeInput();
		let transformer = sharp(input);
		for (const [method, ...args] of transforms) transformer = (transformer as any)[method](...args);
		const output = await transformer.toBuffer();

		expect(output[0]).toBe(0xff);
		expect(output[1]).toBe(0xd8);
		expect(output[2]).toBe(0xff);
	});
});
