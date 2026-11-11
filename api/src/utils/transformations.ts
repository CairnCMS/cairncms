import { isPlainObject } from 'lodash-es';
import type { ResizeOptions } from 'sharp';
import type { File, Transformation, TransformationFormat, TransformationSet } from '../types/index.js';

type Size = { width: number; height: number };

const FORMAT_METHODS: readonly string[] = ['toFormat', 'jpeg', 'png', 'webp', 'avif', 'tiff'];

const RESIZE_OPTIONS: readonly string[] = [
	'width',
	'height',
	'fit',
	'position',
	'background',
	'kernel',
	'withoutEnlargement',
	'withoutReduction',
	'fastShrinkOnLoad',
];

export function resolvePreset({ transformationParams, acceptFormat }: TransformationSet, file: File): Transformation[] {
	const transforms = transformationParams.transforms ? [...transformationParams.transforms] : [];

	if (transformationParams.format || transformationParams.quality) {
		// sharp 0.35 dropped "jpg" from its format type but still accepts it at runtime as jpeg.
		const format = getFormat(file, transformationParams.format, acceptFormat) as Exclude<TransformationFormat, 'jpg'>;

		transforms.push([
			'toFormat',
			format,
			{
				quality: transformationParams.quality ? Number(transformationParams.quality) : undefined,
			},
		]);
	}

	if (transformationParams.width || transformationParams.height) {
		transforms.push([
			'resize',
			{
				width: transformationParams.width ? Number(transformationParams.width) : undefined,
				height: transformationParams.height ? Number(transformationParams.height) : undefined,
				fit: transformationParams.fit,
				withoutEnlargement: transformationParams.withoutEnlargement
					? Boolean(transformationParams.withoutEnlargement)
					: undefined,
			},
		]);
	}

	return transforms;
}

function getFormat(
	file: File,
	format: TransformationSet['transformationParams']['format'],
	acceptFormat: TransformationSet['acceptFormat']
): TransformationFormat {
	const fileType = file.type?.split('/')[1] as TransformationFormat | undefined;

	if (format) {
		if (format !== 'auto') {
			return format;
		}

		if (acceptFormat) {
			return acceptFormat;
		}

		if (fileType && ['avif', 'webp', 'tiff'].includes(fileType)) {
			return 'png';
		}
	}

	return fileType || 'jpg';
}

/**
 * Try to extract a file format from an array of `Transformation`'s.
 */
export function maybeExtractFormat(transforms: Transformation[]): string | undefined {
	const toFormats = transforms.filter((t) => t[0] === 'toFormat');
	const lastToFormat = toFormats[toFormats.length - 1];
	return lastToFormat ? lastToFormat[1]?.toString() : undefined;
}

/**
 * Returns the largest output a transformation can produce from a source of the given size. Returns `null` when the
 * transformation does more than one resize and format conversion, since its output size isn't calculated.
 *
 * The bound is never smaller than the source on either side. That covers `withoutReduction`, and a decoder's
 * shrink-on-load, which can round a reduction above the calculated size.
 */
export function getOutputSizeBound(transforms: Transformation[], source: Size): Size | null {
	const resizes = transforms.filter(([method]) => method === 'resize');

	if (resizes.length > 1) return null;
	if (transforms.some(([method]) => method !== 'resize' && !FORMAT_METHODS.includes(method))) return null;
	if (resizes.length === 0) return source;

	const options = normalizeResize(resizes[0]!.slice(1));

	if (!options) return null;

	const bound = getResizeBound(source, options);

	return { width: Math.max(bound.width, source.width), height: Math.max(bound.height, source.height) };
}

/**
 * Merges Sharp's positional `resize(width, height, options)` form into one options object, as Sharp does. Returns
 * `null` when the options include anything the size calculation doesn't account for.
 */
function normalizeResize([first, second, third]: readonly unknown[]): ResizeOptions | null {
	const firstIsOptions = isPlainObject(first) && third == null;
	const candidate = firstIsOptions ? first : third;
	const options = (isPlainObject(candidate) ? candidate : {}) as Record<string, unknown>;

	if (Object.keys(options).some((key) => !RESIZE_OPTIONS.includes(key))) return null;

	return {
		...options,
		width: options['width'] ?? (firstIsOptions ? undefined : first),
		height: options['height'] ?? second,
	} as ResizeOptions;
}

/**
 * Bounds a single resize before the source floor. `withoutReduction` overrides `withoutEnlargement`, which keeps the
 * source size except that `contain` pads to the requested sides.
 */
function getResizeBound(source: Size, options: ResizeOptions): Size {
	const { width, height, fit, withoutEnlargement, withoutReduction } = options;

	if (!width && !height) return source;

	if (withoutEnlargement && !withoutReduction) {
		return fit === 'contain' ? { width: width || source.width, height: height || source.height } : source;
	}

	return getUnflaggedSize(source, options);
}

/**
 * The size Sharp produces for a resize without `withoutEnlargement` or `withoutReduction`. The side that sets the scale
 * keeps its requested value exactly, and the other side is rounded up.
 */
function getUnflaggedSize(source: Size, { width, height, fit }: ResizeOptions): Size {
	if (width && height) {
		if (fit !== 'inside' && fit !== 'outside') return { width, height };

		const widthIsSmallerRatio = width * source.height <= height * source.width;
		const widthSetsScale = fit === 'inside' ? widthIsSmallerRatio : !widthIsSmallerRatio;

		return widthSetsScale ? scaleToWidth(source, width) : scaleToHeight(source, height);
	}

	if (width) return fit === 'fill' ? { width, height: source.height } : scaleToWidth(source, width);

	const target = height as number;

	return fit === 'fill' ? { width: source.width, height: target } : scaleToHeight(source, target);
}

function scaleToWidth(source: Size, width: number): Size {
	return { width, height: Math.ceil((source.height * width) / source.width) };
}

function scaleToHeight(source: Size, height: number): Size {
	return { width: Math.ceil((source.width * height) / source.height), height };
}
