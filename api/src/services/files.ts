import type { Query } from '@cairncms/types';
import formatTitle from '@cairncms/format-title';
import { toArray } from '@cairncms/utils';
import encodeURL from 'encodeurl';
import exif from 'exif-reader';
import type { IccProfile } from 'icc';
import { parse as parseIcc } from 'icc';
import { clone, pick } from 'lodash-es';
import { extension } from 'mime-types';
import { nanoid } from 'nanoid';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'path';
import sharp from 'sharp';
import url from 'url';
import { SUPPORTED_IMAGE_METADATA_FORMATS } from '../constants.js';
import emitter from '../emitter.js';
import env from '../env.js';
import {
	ContentTooLargeException,
	ForbiddenException,
	InvalidPayloadException,
	ServiceUnavailableException,
} from '../exceptions/index.js';
import logger from '../logger.js';
import { getAxios } from '../request/index.js';
import { getStorage } from '../storage/index.js';
import type { AbstractServiceOptions, File, Metadata, MutationOptions, PrimaryKey } from '../types/index.js';
import { getMaxUploadSize } from '../utils/get-max-upload-size.js';
import { resolveMimeType } from '../utils/mime-type.js';
import { parseIptc, parseXmp } from '../utils/parse-image-metadata.js';
import { createUploadSizeLimit } from '../utils/upload-size-limit.js';
import { AuthorizationService } from './authorization.js';
import { ItemsService } from './items.js';

const SERVER_CONTROLLED_FIELDS = ['filename_disk', 'uploaded_by'] as const;

function sanitizeFilePayload<T extends Partial<File>>(payload: T): T {
	if (!payload || typeof payload !== 'object') return payload;
	const sanitized = { ...payload } as Record<string, unknown>;

	for (const field of SERVER_CONTROLLED_FIELDS) {
		delete sanitized[field];
	}

	return sanitized as T;
}

export class FilesService extends ItemsService {
	constructor(options: AbstractServiceOptions) {
		super('directus_files', options);
	}

	/**
	 * Upload a single new file to the configured storage adapter
	 */
	async uploadOne(
		stream: Readable,
		data: Partial<File> & { storage: string },
		primaryKey?: PrimaryKey,
		opts?: MutationOptions
	): Promise<PrimaryKey> {
		const storage = await getStorage();

		let existingFile = {};
		let existingMetadata: Partial<File> = {};

		if (primaryKey !== undefined) {
			const existing =
				(await this.knex
					.select('folder', 'filename_download', 'storage', 'title', 'description', 'tags', 'metadata')
					.from('directus_files')
					.where({ id: primaryKey })
					.first()) ?? {};

			const { title, description, tags, metadata, ...rest } = existing;

			existingFile = rest;

			// Kept out of the pre-gate payload so a replace preserves operator-set display metadata (applied
			// via the sudo update below) without requiring the caller to hold write access to those fields.
			existingMetadata = { title, description, tags, metadata };
		}

		// The final sudo update bypasses the FilesService sanitizer, so strip caller-controlled fields
		// (filename_disk, uploaded_by) from the data here.
		const payload = { ...existingFile, ...sanitizeFilePayload(clone(data)) };

		if ('folder' in payload === false) {
			const settings = await this.knex.select('storage_default_folder').from('directus_settings').first();

			if (settings?.storage_default_folder) {
				payload.folder = settings.storage_default_folder;
			}
		}

		const isNewFile = primaryKey === undefined;

		// A replace's file write happens before the route's own permission check, so this is the only
		// pre-write gate. It must not mutate the row, so all row changes are deferred until the new object
		// is written. New uploads are gated by createOne below.
		if (isNewFile === false && this.accountability) {
			const authorizationService = new AuthorizationService({
				knex: this.knex,
				schema: this.schema,
				accountability: this.accountability,
			});

			await authorizationService.checkAccess('update', 'directus_files', primaryKey!);

			Object.assign(payload, authorizationService.validatePayload('update', 'directus_files', payload));
		}

		const fileExtension =
			path.extname(payload.filename_download!) || (payload.type && '.' + extension(payload.type)) || '';

		if (primaryKey === undefined) {
			primaryKey = await this.createOne(payload, { emitEvents: false });
			payload.filename_disk = primaryKey + (fileExtension || '');
		} else {
			// Write the replacement to a fresh, primary-key-prefixed object so the existing file stays
			// intact until the write succeeds. A flat key (no path separator) keeps drivers whose public
			// id strips directories on the primary-key prefix that deletion relies on.
			payload.filename_disk = `${primaryKey}-${nanoid(10)}${fileExtension || ''}`;
		}

		if (!payload.type) {
			payload.type = 'application/octet-stream';
		}

		try {
			await storage.location(data.storage).write(payload.filename_disk, stream, payload.type);
		} catch (err: any) {
			logger.warn(`Couldn't save file ${payload.filename_disk}`);
			logger.warn(err);
			await this.cleanupFailedUpload(data.storage, payload.filename_disk, isNewFile, primaryKey);
			throw new ServiceUnavailableException(`Couldn't save file ${payload.filename_disk}`, { service: 'files' });
		}

		// Busboy (multipart) and the URL-import counting stream both flag truncation past the size cap
		// by ending the stream with `truncated`, so a too-large upload must be cleaned up, not persisted.
		if ((stream as Readable & { truncated?: boolean }).truncated) {
			await this.cleanupFailedUpload(data.storage, payload.filename_disk, isNewFile, primaryKey);
			throw new ContentTooLargeException(`Uploaded file is too large`);
		}

		// Any failure between the write and the row referencing the new object would orphan the fresh
		// object (and a new upload's row), so clean up before rethrowing.
		try {
			const { size } = await storage.location(data.storage).stat(payload.filename_disk);
			payload.filesize = size;

			if (SUPPORTED_IMAGE_METADATA_FORMATS.includes(payload.type)) {
				const fileStream = await storage.location(data.storage).read(payload.filename_disk);
				const { height, width, description, title, tags, metadata } = await this.getMetadata(fileStream);

				payload.height ??= height ?? null;
				payload.width ??= width ?? null;
				// On a replace, keep operator-set title/description/tags (unless the caller re-supplied them)
				// rather than nulling them when the new file carries no embedded values.
				payload.description ??= existingMetadata.description ?? description ?? null;
				payload.title ??= existingMetadata.title ?? title ?? null;
				payload.tags ??= existingMetadata.tags ?? tags ?? null;
				payload.metadata ??= existingMetadata.metadata ?? metadata ?? null;
			}

			// We do this in a service without accountability. Even if you don't have update permissions to
			// the file, we still want to be able to set the extracted values from the file on create
			const sudoService = new ItemsService('directus_files', {
				knex: this.knex,
				schema: this.schema,
			});

			await sudoService.updateOne(primaryKey, payload, { emitEvents: false });
		} catch (err: any) {
			await this.cleanupFailedUpload(data.storage, payload.filename_disk, isNewFile, primaryKey);
			throw err;
		}

		if (isNewFile === false) {
			// The row now references the new object. Remove the previous objects from the old location,
			// never the live one. A failure here only leaks old bytes (the new file is already live), so it
			// is logged, not thrown.
			const oldLocation = (existingFile as { storage?: string }).storage ?? payload.storage;
			const disk = storage.location(oldLocation);

			try {
				for await (const filepath of disk.list(String(primaryKey))) {
					if (oldLocation === payload.storage && filepath === payload.filename_disk) continue;
					await disk.delete(filepath);
				}
			} catch (err: any) {
				logger.warn(`Couldn't remove the previous objects for file ${primaryKey} after a replace`);
				logger.warn(err);
			}
		}

		if (opts?.emitEvents !== false) {
			emitter.emitAction(
				'files.upload',
				{
					payload,
					key: primaryKey,
					collection: this.collection,
				},
				{
					database: this.knex,
					schema: this.schema,
					accountability: this.accountability,
				}
			);
		}

		return primaryKey;
	}

	/**
	 * Clean up after an upload that failed or was rejected mid-write. A replace leaves the existing row
	 * and binary untouched and drops only the freshly written object. A new upload's created row and
	 * object are removed. Best-effort: a cleanup failure is logged, not thrown, so the original upload
	 * error still surfaces.
	 */
	private async cleanupFailedUpload(
		location: string,
		filenameDisk: string,
		isNewFile: boolean,
		primaryKey: PrimaryKey
	): Promise<void> {
		// Object cleanup and row cleanup are guarded independently so a storage failure (a bad or removed
		// location) cannot prevent the dangling row from being removed.
		try {
			const storage = await getStorage();
			await storage.location(location).delete(filenameDisk);
		} catch (err: any) {
			logger.warn(`Couldn't remove ${filenameDisk} after a failed upload`);
			logger.warn(err);
		}

		if (isNewFile) {
			try {
				const sudoService = new ItemsService('directus_files', { knex: this.knex, schema: this.schema });
				await sudoService.deleteOne(primaryKey, { emitEvents: false });
			} catch (err: any) {
				logger.warn(`Couldn't remove the file row ${primaryKey} after a failed upload`);
				logger.warn(err);
			}
		}
	}

	/**
	 * Extract metadata from a buffer's content
	 */
	async getMetadata(stream: Readable, allowList = env['FILE_METADATA_ALLOW_LIST']): Promise<Metadata> {
		return new Promise((resolve, reject) => {
			pipeline(
				stream,
				sharp().metadata(async (err, sharpMetadata) => {
					if (err) {
						reject(err);
						return;
					}

					const metadata: Metadata = {};

					if (sharpMetadata.orientation && sharpMetadata.orientation >= 5) {
						metadata.height = sharpMetadata.width;
						metadata.width = sharpMetadata.height;
					} else {
						metadata.width = sharpMetadata.width;
						metadata.height = sharpMetadata.height;
					}

					// Backward-compatible layout as it used to be with 'exifr'
					const fullMetadata: {
						ifd0?: Record<string, unknown>;
						ifd1?: Record<string, unknown>;
						exif?: Record<string, unknown>;
						gps?: Record<string, unknown>;
						interop?: Record<string, unknown>;
						icc?: IccProfile;
						iptc?: Record<string, unknown>;
						xmp?: Record<string, unknown>;
					} = {};

					if (sharpMetadata.exif) {
						try {
							const { image, thumbnail, interoperability, ...rest } = exif(sharpMetadata.exif);

							if (image) {
								fullMetadata.ifd0 = image;
							}

							if (thumbnail) {
								fullMetadata.ifd1 = thumbnail;
							}

							if (interoperability) {
								fullMetadata.interop = interoperability;
							}

							Object.assign(fullMetadata, rest);
						} catch (err) {
							logger.warn(`Couldn't extract EXIF metadata from file`);
							logger.warn(err);
						}
					}

					if (sharpMetadata.icc) {
						try {
							fullMetadata.icc = parseIcc(sharpMetadata.icc);
						} catch (err) {
							logger.warn(`Couldn't extract ICC profile data from file`);
							logger.warn(err);
						}
					}

					if (sharpMetadata.iptc) {
						try {
							fullMetadata.iptc = parseIptc(sharpMetadata.iptc);
						} catch (err) {
							logger.warn(`Couldn't extract IPTC Photo Metadata from file`);
							logger.warn(err);
						}
					}

					if (sharpMetadata.xmp) {
						try {
							fullMetadata.xmp = parseXmp(sharpMetadata.xmp);
						} catch (err) {
							logger.warn(`Couldn't extract XMP data from file`);
							logger.warn(err);
						}
					}

					if (fullMetadata?.iptc?.['Caption'] && typeof fullMetadata.iptc['Caption'] === 'string') {
						metadata.description = fullMetadata.iptc?.['Caption'];
					}

					if (fullMetadata?.iptc?.['Headline'] && typeof fullMetadata.iptc['Headline'] === 'string') {
						metadata.title = fullMetadata.iptc['Headline'];
					}

					if (fullMetadata?.iptc?.['Keywords']) {
						metadata.tags = fullMetadata.iptc['Keywords'];
					}

					if (allowList === '*' || allowList?.[0] === '*') {
						metadata.metadata = fullMetadata;
					} else {
						metadata.metadata = pick(fullMetadata, allowList);
					}

					// Fix (incorrectly parsed?) values starting / ending with spaces,
					// limited to one level and string values only
					for (const section of Object.keys(metadata.metadata)) {
						for (const [key, value] of Object.entries(metadata.metadata[section])) {
							if (typeof value === 'string') {
								metadata.metadata[section][key] = value.trim();
							}
						}
					}

					resolve(metadata);
				})
			);
		});
	}

	/**
	 * Import a single file from an external URL
	 */
	async importOne(importURL: string, body: Partial<File>): Promise<PrimaryKey> {
		const fileCreatePermissions = this.accountability?.permissions?.find(
			(permission) => permission.collection === 'directus_files' && permission.action === 'create'
		);

		if (this.accountability && this.accountability?.admin !== true && !fileCreatePermissions) {
			throw new ForbiddenException();
		}

		let fileResponse;

		try {
			const axios = await getAxios();

			fileResponse = await axios.get<Readable>(encodeURL(importURL), {
				responseType: 'stream',
			});
		} catch (err: any) {
			logger.warn(err, `Couldn't fetch file from URL "${importURL}"`);
			throw new ServiceUnavailableException(`Couldn't fetch file from url "${importURL}"`, {
				service: 'external-file',
			});
		}

		const parsedURL = url.parse(fileResponse.request.res.responseUrl);
		const filename = decodeURI(path.basename(parsedURL.pathname as string));

		const contentType = fileResponse.headers['content-type'];
		const { mimeType, allowed } = resolveMimeType(typeof contentType === 'string' ? contentType : undefined);

		if (allowed === false) {
			fileResponse.data.destroy();
			throw new InvalidPayloadException(`File is of invalid content type`);
		}

		const payload = {
			filename_download: filename,
			storage: toArray(env['STORAGE_LOCATIONS'])[0],
			title: formatTitle(filename),
			...(body || {}),
			// The server-resolved, allow-list-checked type wins over any caller-supplied type.
			type: mimeType,
		};

		// URL imports honor the same size cap as multipart uploads by counting bytes as they stream.
		const maxUploadSize = getMaxUploadSize();

		const stream =
			maxUploadSize === undefined ? fileResponse.data : createUploadSizeLimit(fileResponse.data, maxUploadSize);

		return await this.uploadOne(stream, payload);
	}

	/**
	 * Create a file (only applicable when it is not a multipart/data POST request)
	 * Useful for associating metadata with existing file in storage
	 */
	override async createOne(data: Partial<File>, opts?: MutationOptions): Promise<PrimaryKey> {
		const sanitized = sanitizeFilePayload(data);

		if (!sanitized.type) {
			throw new InvalidPayloadException(`"type" is required`);
		}

		const key = await super.createOne(sanitized, opts);
		return key;
	}

	override async createMany(data: Partial<File>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		return super.createMany(data.map(sanitizeFilePayload), opts);
	}

	override async updateOne(key: PrimaryKey, data: Partial<File>, opts?: MutationOptions): Promise<PrimaryKey> {
		return super.updateOne(key, sanitizeFilePayload(data), opts);
	}

	override async updateMany(keys: PrimaryKey[], data: Partial<File>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		return super.updateMany(keys, sanitizeFilePayload(data), opts);
	}

	override async updateBatch(data: Partial<File>[], opts?: MutationOptions): Promise<PrimaryKey[]> {
		return super.updateBatch(data.map(sanitizeFilePayload), opts);
	}

	override async updateByQuery(query: Query, data: Partial<File>, opts?: MutationOptions): Promise<PrimaryKey[]> {
		return super.updateByQuery(query, sanitizeFilePayload(data), opts);
	}

	/**
	 * Delete a file
	 */
	override async deleteOne(key: PrimaryKey, opts?: MutationOptions): Promise<PrimaryKey> {
		await this.deleteMany([key], opts);
		return key;
	}

	/**
	 * Delete multiple files
	 */
	override async deleteMany(keys: PrimaryKey[], _opts?: MutationOptions): Promise<PrimaryKey[]> {
		const storage = await getStorage();
		const files = await super.readMany(keys, { fields: ['id', 'storage'], limit: -1 });

		if (!files) {
			throw new ForbiddenException();
		}

		await super.deleteMany(keys);

		for (const file of files) {
			const disk = storage.location(file['storage']);

			// Delete file + thumbnails
			for await (const filepath of disk.list(file['id'])) {
				await disk.delete(filepath);
			}
		}

		return keys;
	}
}
