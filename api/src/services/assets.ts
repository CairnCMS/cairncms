import type { Range, Stat } from '@cairncms/storage';
import type { Accountability } from '@cairncms/types';
import type { Knex } from 'knex';
import { clamp } from 'lodash-es';
import { contentType } from 'mime-types';
import type { Readable } from 'node:stream';
import hash from 'object-hash';
import path from 'path';
import sharp from 'sharp';
import validateUUID from 'uuid-validate';
import { SUPPORTED_IMAGE_TRANSFORM_FORMATS } from '../constants.js';
import getDatabase from '../database/index.js';
import env from '../env.js';
import { ForbiddenException } from '../exceptions/forbidden.js';
import { IllegalAssetTransformation } from '../exceptions/illegal-asset-transformation.js';
import { RangeNotSatisfiableException } from '../exceptions/range-not-satisfiable.js';
import { ServiceUnavailableException } from '../exceptions/service-unavailable.js';
import logger from '../logger.js';
import { getStorage } from '../storage/index.js';
import type { AbstractServiceOptions, File, Transformation, TransformationParams } from '../types/index.js';
import { getMilliseconds } from '../utils/get-milliseconds.js';
import * as TransformationUtils from '../utils/transformations.js';
import { AuthorizationService } from './authorization.js';

type StorageLocation = Awaited<ReturnType<typeof getStorage>>['location'] extends (name: string) => infer L ? L : never;

type ResolvedAsset = {
	file: File;
	storageLocation: StorageLocation;
	sourceFilename: string;
	transforms: Transformation[];
	transformedFilename: string | null;
	transformedExists: boolean;
};

export class AssetsService {
	knex: Knex;
	accountability: Accountability | null;
	authorizationService: AuthorizationService;

	constructor(options: AbstractServiceOptions) {
		this.knex = options.knex || getDatabase();
		this.accountability = options.accountability || null;
		this.authorizationService = new AuthorizationService(options);
	}

	async statAsset(
		id: string,
		transformation: TransformationParams,
		range?: Range
	): Promise<{ file: any; stat: Stat | null }> {
		const { file, storageLocation, sourceFilename, transformedFilename, transformedExists } = await this._resolveAsset(
			id,
			transformation,
			range
		);

		if (transformedFilename) {
			if (transformedExists) {
				return { file, stat: await storageLocation.stat(transformedFilename) };
			}

			return { file, stat: null };
		}

		return { file, stat: await storageLocation.stat(sourceFilename) };
	}

	async getAsset(
		id: string,
		transformation: TransformationParams,
		range?: Range
	): Promise<{ stream: Readable; file: any; stat: Stat }> {
		const { file, storageLocation, sourceFilename, transforms, transformedFilename, transformedExists } =
			await this._resolveAsset(id, transformation, range);

		if (transformedFilename) {
			if (transformedExists) {
				return {
					stream: await storageLocation.read(transformedFilename, range),
					file,
					stat: await storageLocation.stat(transformedFilename),
				};
			}

			// Dimension precheck must precede the read stream; sharp's own limitInputPixels fires too late.
			const { width, height } = file;

			if (
				!width ||
				!height ||
				width > env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION'] ||
				height > env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION']
			) {
				throw new IllegalAssetTransformation(
					`Image is too large to be transformed, or image size couldn't be determined.`
				);
			}

			const { queue, process } = sharp.counters();

			if (queue + process > env['ASSETS_TRANSFORM_MAX_CONCURRENT']) {
				throw new ServiceUnavailableException('Server too busy', {
					service: 'files',
				});
			}

			const transformer = sharp({
				limitInputPixels: Math.pow(env['ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION'], 2),
				sequentialRead: true,
				failOn: env['ASSETS_INVALID_IMAGE_SENSITIVITY_LEVEL'],
			});

			transformer.timeout({
				seconds: clamp(Math.round(getMilliseconds(env['ASSETS_TRANSFORM_TIMEOUT'], 0) / 1000), 1, 3600),
			});

			if (transforms.find((transform) => transform[0] === 'rotate') === undefined) transformer.rotate();

			transforms.forEach(([method, ...args]) => (transformer[method] as any).apply(transformer, args));

			const readStream = await storageLocation.read(sourceFilename, range);

			readStream.on('error', (e: Error) => {
				logger.error(e, `Couldn't transform file ${file.id}`);
			});

			try {
				await storageLocation.write(transformedFilename, readStream.pipe(transformer), file.type ?? undefined);
			} catch (err) {
				readStream.destroy();
				throw err;
			}

			return {
				stream: await storageLocation.read(transformedFilename, range),
				stat: await storageLocation.stat(transformedFilename),
				file,
			};
		}

		const readStream = await storageLocation.read(sourceFilename, range);
		const stat = await storageLocation.stat(sourceFilename);
		return { stream: readStream, file, stat };
	}

	private async _resolveAsset(id: string, transformation: TransformationParams, range?: Range): Promise<ResolvedAsset> {
		const storage = await getStorage();

		const publicSettings = await this.knex
			.select('project_logo', 'public_background', 'public_foreground')
			.from('directus_settings')
			.first();

		const systemPublicKeys = Object.values(publicSettings || {});

		// Postgres errors when a non-UUID string is used in a WHERE on a UUID column; validate up front.
		const isValidUUID = validateUUID(id, 4);

		if (isValidUUID === false) throw new ForbiddenException();

		if (systemPublicKeys.includes(id) === false && this.accountability?.admin !== true) {
			await this.authorizationService.checkAccess('read', 'directus_files', id);
		}

		const file = (await this.knex.select('*').from('directus_files').where({ id }).first()) as File;

		if (!file) throw new ForbiddenException();

		const storageLocation = storage.location(file.storage);
		const exists = await storageLocation.exists(file.filename_disk);

		if (!exists) throw new ForbiddenException();

		if (range) {
			const missingRangeLimits = range.start === undefined && range.end === undefined;
			const endBeforeStart = range.start !== undefined && range.end !== undefined && range.end <= range.start;
			const startOverflow = range.start !== undefined && range.start >= file.filesize;
			const endUnderflow = range.end !== undefined && range.end <= 0;

			if (missingRangeLimits || endBeforeStart || startOverflow || endUnderflow) {
				throw new RangeNotSatisfiableException(range);
			}

			const lastByte = file.filesize - 1;

			if (range.end) {
				if (range.start === undefined) {
					range.start = file.filesize - range.end;
					range.end = lastByte;
				}

				if (range.end >= file.filesize) {
					range.end = lastByte;
				}
			}

			if (range.start) {
				if (range.end === undefined) {
					range.end = lastByte;
				}

				if (range.start < 0) {
					range.start = 0;
				}
			}
		}

		const type = file.type;
		const transforms = TransformationUtils.resolvePreset(transformation, file);

		if (!type || transforms.length === 0 || !SUPPORTED_IMAGE_TRANSFORM_FORMATS.includes(type)) {
			return {
				file,
				storageLocation,
				sourceFilename: file.filename_disk,
				transforms,
				transformedFilename: null,
				transformedExists: false,
			};
		}

		const maybeNewFormat = TransformationUtils.maybeExtractFormat(transforms);

		const transformedFilename =
			path.basename(file.filename_disk, path.extname(file.filename_disk)) +
			getAssetSuffix(transforms) +
			(maybeNewFormat ? `.${maybeNewFormat}` : path.extname(file.filename_disk));

		if (maybeNewFormat) {
			file.type = contentType(transformedFilename) || null;
		}

		const transformedExists = await storageLocation.exists(transformedFilename);

		return {
			file,
			storageLocation,
			sourceFilename: file.filename_disk,
			transforms,
			transformedFilename,
			transformedExists,
		};
	}
}

const getAssetSuffix = (transforms: Transformation[]) => {
	if (Object.keys(transforms).length === 0) return '';
	return `__${hash(transforms)}`;
};
