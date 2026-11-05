import sharp, { type ResizeOptions } from 'sharp';
import { expect, test, describe } from 'vitest';
import { SYSTEM_ASSET_ALLOW_LIST } from '../constants.js';
import { getOutputSizeBound, maybeExtractFormat, resolvePreset } from './transformations.js';
import type { File } from '../types/files.js';
import type { Transformation, TransformationParams } from '../types/assets.js';

const inputFile: File = {
	id: '43a15f67-84a7-4e07-880d-e46a9f33c542',
	storage: 'local',
	filename_disk: 'test',
	filename_download: 'test',
	title: null,
	type: null,
	folder: null,
	uploaded_by: null,
	uploaded_on: new Date(),
	charset: null,
	filesize: 123,
	width: null,
	height: null,
	duration: null,
	embed: null,
	description: null,
	location: null,
	tags: null,
	metadata: null,
};

describe('resolvePreset', () => {
	test('does not mutate input.transforms on a single call', () => {
		const transformationParams: TransformationParams = {
			key: 'system-small-cover',
			format: 'jpg',
			transforms: [
				[
					'resize',
					{
						width: 64,
						height: 64,
						fit: 'cover',
					},
				],
			],
		};

		resolvePreset({ transformationParams }, inputFile);

		expect(transformationParams.transforms).toStrictEqual([
			[
				'resize',
				{
					width: 64,
					height: 64,
					fit: 'cover',
				},
			],
		]);
	});

	test('does not accumulate transforms in input across repeated calls', () => {
		const transformationParams: TransformationParams = {
			key: 'system-small-cover',
			format: 'jpg',
			transforms: [
				[
					'resize',
					{
						width: 64,
						height: 64,
						fit: 'cover',
					},
				],
			],
		};

		resolvePreset({ transformationParams }, inputFile);
		resolvePreset({ transformationParams }, inputFile);
		resolvePreset({ transformationParams }, inputFile);

		expect(transformationParams.transforms).toHaveLength(1);

		expect(transformationParams.transforms).toStrictEqual([
			[
				'resize',
				{
					width: 64,
					height: 64,
					fit: 'cover',
				},
			],
		]);
	});

	test('Add toFormat transformation', () => {
		const transformationParams: TransformationParams = {
			key: 'system-small-cover',
			format: 'jpg',
			quality: 80,
			transforms: [
				[
					'resize',
					{
						width: 64,
						height: 64,
						fit: 'cover',
					},
				],
			],
		};

		const output = resolvePreset({ transformationParams }, inputFile);

		expect(output).toStrictEqual([
			[
				'resize',
				{
					width: 64,
					height: 64,
					fit: 'cover',
				},
			],
			['toFormat', 'jpg', { quality: 80 }],
		]);
	});

	test('Add resize transformation', () => {
		const transformationParams: TransformationParams = {
			key: 'system-small-cover',
			width: 64,
			height: 64,
			fit: 'cover',
		};

		const output = resolvePreset({ transformationParams }, inputFile);

		expect(output).toStrictEqual([
			[
				'resize',
				{
					width: 64,
					height: 64,
					fit: 'cover',
					withoutEnlargement: undefined,
				},
			],
		]);
	});

	test('Resolve auto format (fallback)', () => {
		const transformationParams: TransformationParams = {
			format: 'auto',
		};

		const output = resolvePreset({ transformationParams }, inputFile);

		expect(output).toStrictEqual([['toFormat', 'jpg', { quality: undefined }]]);
	});

	test('Resolve auto format (with accept header)', () => {
		const transformationParams: TransformationParams = {
			format: 'auto',
		};

		const output = resolvePreset({ transformationParams, acceptFormat: 'avif' }, inputFile);

		expect(output).toStrictEqual([['toFormat', 'avif', { quality: undefined }]]);
	});

	test('Resolve auto format (format with transparency support)', () => {
		const transformationParams: TransformationParams = {
			format: 'auto',
		};

		const inputFileAvif = { ...inputFile, type: 'image/avif' };

		const output = resolvePreset({ transformationParams }, inputFileAvif);

		expect(output).toStrictEqual([['toFormat', 'png', { quality: undefined }]]);
	});

	test('Resolve auto format (original type)', () => {
		const transformationParams: TransformationParams = {
			format: 'auto',
		};

		const inputFilePng = { ...inputFile, type: 'image/png' };

		const output = resolvePreset({ transformationParams }, inputFilePng);

		expect(output).toStrictEqual([['toFormat', 'png', { quality: undefined }]]);
	});
});

describe('maybeExtractFormat', () => {
	test('get last format', () => {
		const inputTransformations: Transformation[] = [
			// @ts-expect-error Sharp accepts the jpg alias at runtime but declares only jpeg.
			['toFormat', 'jpg', { quality: 80 }],
			['toFormat', 'webp', { quality: 80 }],
		];

		const output = maybeExtractFormat(inputTransformations);

		expect(output).toBe('webp');
	});

	test('get undefined', () => {
		const inputTransformations: Transformation[] = [];

		const output = maybeExtractFormat(inputTransformations);

		expect(output).toBe(undefined);
	});
});

/**
 * Builds a resize in Sharp's positional form, which requests can carry but the `Transformation` type doesn't model.
 */
function positionalResize(...args: unknown[]): Transformation {
	return ['resize', ...args] as unknown as Transformation;
}

describe('getOutputSizeBound', () => {
	const size = (width: number, height: number) => ({ width, height });

	test.each<[string, [number, number], ResizeOptions, [number, number]]>([
		['withoutReduction keeps the larger of each side', [800, 600], { width: 200, withoutReduction: true }, [800, 600]],
		['withoutReduction still enlarges', [20, 10], { width: 200, withoutReduction: true }, [200, 100]],
		[
			'withoutReduction wins over withoutEnlargement',
			[20, 10],
			{ width: 200, withoutEnlargement: true, withoutReduction: true },
			[200, 100],
		],
		[
			'contain with withoutEnlargement pads to the given side',
			[20, 10],
			{ width: 200, fit: 'contain', withoutEnlargement: true },
			[200, 10],
		],
		[
			'contain with withoutEnlargement pads to both sides',
			[1, 20],
			{ width: 200, height: 100, fit: 'contain', withoutEnlargement: true },
			[200, 100],
		],
		['withoutEnlargement keeps the source', [20, 10], { width: 200, height: 100, withoutEnlargement: true }, [20, 10]],
		['both sides with the default fit', [1, 20], { width: 200, height: 100 }, [200, 100]],
		['both sides with fill', [1, 20], { width: 200, height: 100, fit: 'fill' }, [200, 100]],
		['both sides with inside', [1, 20], { width: 200, height: 100, fit: 'inside' }, [5, 100]],
		['both sides with outside', [1, 20], { width: 200, height: 100, fit: 'outside' }, [200, 4000]],
		['inside with the requested width exact', [15, 14], { width: 1000, height: 1000, fit: 'inside' }, [1000, 934]],
		['outside with the requested height exact', [16, 15], { width: 1000, height: 1000, fit: 'outside' }, [1067, 1000]],
		['one side with fill', [20, 10], { width: 200, fit: 'fill' }, [200, 10]],
		['a width with the default fit', [1, 20], { width: 200 }, [200, 4000]],
		['a height with the default fit, rounded up', [800, 600], { height: 1000 }, [1334, 1000]],
		['a reduction at the source size', [800, 600], { width: 200 }, [800, 600]],
		['no sizes', [800, 600], { fit: 'contain' }, [800, 600]],
	])('bounds %s', (_label, [width, height], options, [boundWidth, boundHeight]) => {
		expect(getOutputSizeBound([['resize', options]], size(width, height))).toEqual(size(boundWidth, boundHeight));
	});

	test('returns the source size for format conversions alone', () => {
		const transforms: Transformation[] = [
			['toFormat', 'webp', { quality: 80 }],
			['jpeg', { quality: 70 }],
			['png'],
			['webp'],
			['avif'],
			['tiff'],
		];

		expect(getOutputSizeBound(transforms, size(800, 600))).toEqual(size(800, 600));
	});

	test('bounds a resize with format conversions and size-neutral options', () => {
		const transforms: Transformation[] = [
			['resize', { width: 7000, position: 'top', background: '#000', kernel: 'nearest', fastShrinkOnLoad: false }],
			['toFormat', 'png'],
		];

		expect(getOutputSizeBound(transforms, size(800, 600))).toEqual(size(7000, 5250));
	});

	test.each<[string, Transformation[]]>([
		[
			'another operation',
			[
				['resize', { width: 100 }],
				['blur', 2],
			],
		],
		[
			'a second resize',
			[
				['resize', { width: 100 }],
				['resize', { width: 200 }],
			],
		],
		['an unrecognized resize option', [['resize', { width: 100, scale: 2 } as ResizeOptions]]],
		['an unrecognized option in the positional form', [positionalResize(100, 100, { scale: 2 })]],
	])('treats a list with %s as advanced', (_label, transforms) => {
		expect(getOutputSizeBound(transforms, size(800, 600))).toBeNull();
	});

	test.each<[string, Transformation, [number, number]]>([
		['a positional width', positionalResize(200), [200, 150]],
		['positional width and height', positionalResize(200, 100), [200, 100]],
		['a positional height with options', positionalResize(null, 100, { fit: 'fill' }), [80, 100]],
		['option sizes over positional ones', positionalResize(200, 100, { width: 300 }), [300, 100]],
		['a positional height after an options object', positionalResize({ width: 200 }, 100), [200, 100]],
	])('normalizes %s', (_label, transform, [boundWidth, boundHeight]) => {
		expect(getOutputSizeBound([transform], size(80, 60))).toEqual(size(boundWidth, boundHeight));
	});

	test.each([
		['omitted', undefined],
		['null', null],
		['empty', []],
	])('bounds a preset whose stored transforms are %s', (_label, transforms) => {
		const transformationParams = { width: 7000, height: 100, format: 'auto', transforms } as TransformationParams;
		const resolved = resolvePreset({ transformationParams }, { ...inputFile, type: 'image/png' });

		expect(getOutputSizeBound(resolved, size(80, 60))).toEqual(size(7000, 100));
	});

	test('bounds every built-in key', () => {
		for (const transformationParams of SYSTEM_ASSET_ALLOW_LIST) {
			const resolved = resolvePreset({ transformationParams }, { ...inputFile, type: 'image/png' });

			expect(getOutputSizeBound(resolved, size(800, 600))).not.toBeNull();
		}
	});
});

describe('getOutputSizeBound against Sharp', () => {
	const shapes: ResizeOptions[] = [
		{ width: 5 },
		{ width: 200 },
		{ height: 1 },
		{ height: 5 },
		{ height: 200 },
		{ width: 200, height: 100 },
		{ width: 5, height: 300 },
		{ width: 3, height: 2 },
	];

	const fits = [undefined, 'cover', 'contain', 'fill', 'inside', 'outside'] as const;

	const flagSets: ResizeOptions[] = [
		{},
		{ withoutEnlargement: true },
		{ withoutReduction: true },
		{ withoutEnlargement: true, withoutReduction: true },
	];

	const sources: [number, number][] = [
		[20, 10],
		[1, 20],
		[800, 600],
		[37, 1000],
		[1000, 37],
		[97, 3],
		[15, 14],
	];

	const cases = sources.flatMap(([width, height]) =>
		(['png', 'jpeg', 'webp'] as const).map((format): [typeof format, number, number] => [format, width, height])
	);

	test.each(cases)(
		'never exceeds the bound for a %s %ix%i source',
		async (format, width, height) => {
			const input = await sharp({ create: { width, height, channels: 3, background: '#808080' } })
				.toFormat(format)
				.toBuffer();

			const exceeded: string[] = [];

			for (const shape of shapes) {
				for (const fit of fits) {
					for (const flags of flagSets) {
						const options: ResizeOptions = { ...shape, fit, ...flags };
						const positional = { fit, ...flags };

						const forms: [Transformation, Promise<{ info: { width: number; height: number } }>][] = [
							[['resize', options], sharp(input).resize(options).raw().toBuffer({ resolveWithObject: true })],
						];

						if (format === 'png') {
							forms.push([
								positionalResize(shape.width ?? null, shape.height ?? null, positional),
								sharp(input)
									.resize(shape.width ?? null, shape.height ?? null, positional)
									.raw()
									.toBuffer({ resolveWithObject: true }),
							]);
						}

						for (const [transform, result] of forms) {
							const { info } = await result;
							const bound = getOutputSizeBound([transform], { width, height })!;

							if (info.width > bound.width || info.height > bound.height) {
								exceeded.push(`${JSON.stringify(transform)} gave ${info.width}x${info.height}`);
							}
						}
					}
				}
			}

			expect(exceeded).toEqual([]);
		},
		15000
	);
});
