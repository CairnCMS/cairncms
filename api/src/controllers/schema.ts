import { parseJSON } from '@cairncms/utils';
import Busboy from 'busboy';
import type { RequestHandler } from 'express';
import express from 'express';
import { load as loadYaml } from 'js-yaml';
import {
	ForbiddenException,
	InvalidPayloadException,
	InvalidQueryException,
	UnsupportedMediaTypeException,
} from '../exceptions/index.js';
import logger from '../logger.js';
import { respond } from '../middleware/respond.js';
import { SchemaService } from '../services/schema.js';
import type { Snapshot, SnapshotDiffWithHash } from '../types/index.js';
import asyncHandler from '../utils/async-handler.js';
import { toKeyFormSnapshot } from '../utils/folder-references.js';
import { getVersionedHash } from '../utils/get-versioned-hash.js';
import {
	DEFAULT_SNAPSHOT_VERSION,
	SUPPORTED_SNAPSHOT_VERSIONS,
	type SnapshotVersion,
} from '../utils/schema-contract.js';

const router = express.Router();

function snapshotVersion(raw: unknown): SnapshotVersion {
	if (raw === undefined) return DEFAULT_SNAPSHOT_VERSION;

	const version = SUPPORTED_SNAPSHOT_VERSIONS.find((supported) => String(supported) === raw);

	if (version === undefined) {
		throw new InvalidQueryException(`"version" must be one of [${SUPPORTED_SNAPSHOT_VERSIONS.join(', ')}]`);
	}

	return version;
}

router.get(
	'/snapshot',
	asyncHandler(async (req, res, next) => {
		if (req.accountability?.admin !== true) throw new ForbiddenException();

		const service = new SchemaService({ accountability: req.accountability });
		const currentSnapshot = await service.snapshot({ version: snapshotVersion(req.query['version']) });
		res.locals['payload'] = { data: currentSnapshot };
		return next();
	}),
	respond
);

const schemaMultipartHandler: RequestHandler = (req, res, next) => {
	if (req.accountability?.admin !== true) throw new ForbiddenException();

	if (req.is('application/json')) {
		if (Object.keys(req.body).length === 0) {
			throw new InvalidPayloadException(`No data was included in the body`);
		}

		res.locals['upload'] = req.body;
		return next();
	}

	if (!req.is('multipart/form-data')) {
		throw new UnsupportedMediaTypeException(`Unsupported Content-Type header`);
	}

	const headers = req.headers['content-type']
		? req.headers
		: {
				...req.headers,
				'content-type': 'application/octet-stream',
		  };

	const busboy = Busboy({ headers });

	let isFileIncluded = false;
	let upload: any | null = null;

	busboy.on('file', async (_, fileStream, { mimeType }) => {
		if (isFileIncluded) return next(new InvalidPayloadException(`More than one file was included in the body`));

		isFileIncluded = true;

		const { readableStreamToString } = await import('@cairncms/utils/node');

		try {
			const uploadedString = await readableStreamToString(fileStream);

			if (mimeType === 'application/json') {
				try {
					upload = parseJSON(uploadedString);
				} catch (err: any) {
					logger.warn(err);
					throw new InvalidPayloadException('The provided JSON is invalid.');
				}
			} else {
				try {
					upload = await loadYaml(uploadedString);
				} catch (err: any) {
					logger.warn(err);
					throw new InvalidPayloadException('The provided YAML is invalid.');
				}
			}

			if (!upload) {
				throw new InvalidPayloadException(`No file was included in the body`);
			}

			res.locals['upload'] = upload;

			return next();
		} catch (error: any) {
			busboy.emit('error', error);
		}
	});

	busboy.on('error', (error: Error) => next(error));

	busboy.on('close', () => {
		if (!isFileIncluded) return next(new InvalidPayloadException(`No file was included in the body`));
	});

	req.pipe(busboy);
};

router.post(
	'/diff',
	asyncHandler(schemaMultipartHandler),
	asyncHandler(async (req, res, next) => {
		const service = new SchemaService({ accountability: req.accountability });
		const snapshot: Snapshot = res.locals['upload'];
		const currentSnapshot = await service.snapshot({ version: 1 });
		const currentKeyForm = await toKeyFormSnapshot(currentSnapshot, { database: service.knex });

		const snapshotDiff = await service.diff(snapshot, {
			currentSnapshot,
			currentKeyForm,
			force: 'force' in req.query,
		});

		if (!snapshotDiff) return next();

		const currentSnapshotHash = getVersionedHash(currentKeyForm.snapshot);
		res.locals['payload'] = { data: { hash: currentSnapshotHash, diff: snapshotDiff } };
		return next();
	}),
	respond
);

router.post(
	'/apply',
	asyncHandler(schemaMultipartHandler),
	asyncHandler(async (req, res, next) => {
		const service = new SchemaService({ accountability: req.accountability });
		const diff: SnapshotDiffWithHash = res.locals['upload'];
		await service.apply(diff);
		return next();
	}),
	respond
);

export default router;
