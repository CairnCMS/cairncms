import type { ResizeOptions, Sharp } from 'sharp';

// List of allowed sharp methods to expose.
//
// This is a literal, so we can use it to validate request parameters.
export const TransformationMethods /*: readonly (keyof Sharp)[]*/ = [
	// Output options
	'toFormat',
	'jpeg',
	'png',
	'tiff',
	'webp',
	'avif',

	// Resizing
	'resize',
	'extend',
	'extract',
	'trim',

	// Image operations
	'rotate',
	'flip',
	'flop',
	'sharpen',
	'median',
	'blur',
	'flatten',
	'gamma',
	'negate',
	'normalise',
	'normalize',
	'clahe',
	'convolve',
	'threshold',
	'linear',
	'recomb',
	'modulate',

	// Color manipulation
	'tint',
	'greyscale',
	'grayscale',
	'toColorspace',
	'toColourspace',

	// Channel manipulation
	'removeAlpha',
	'ensureAlpha',
	'extractChannel',
	'bandbool',
] as const;

// Helper types
type AllowedSharpMethods = Pick<Sharp, (typeof TransformationMethods)[number]>;

export type TransformationMap = {
	[M in keyof AllowedSharpMethods]: readonly [M, ...Parameters<AllowedSharpMethods[M]>];
};

export type Transformation = TransformationMap[keyof TransformationMap];

export type TransformationResize = Pick<ResizeOptions, 'width' | 'height' | 'fit' | 'withoutEnlargement'>;

export type TransformationParams = {
	key?: string;
	transforms?: Transformation[];
	format?: 'auto' | 'jpg' | 'jpeg' | 'png' | 'webp' | 'tiff' | 'avif';
	quality?: number;
} & TransformationResize;
