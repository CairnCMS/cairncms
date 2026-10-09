import { TYPES } from '@cairncms/constants';
import Joi from 'joi';
import { isPlainObject } from 'lodash-es';
import { ALIAS_TYPES } from '../constants.js';
import { getDatabaseClient } from '../database/index.js';
import { InvalidPayloadException } from '../exceptions/invalid-payload.js';
import type { PortableSnapshot, Snapshot } from '../types/index.js';
import { DatabaseClients } from '../types/index.js';
import { version as currentRelease } from './package.js';
import { SUPPORTED_SNAPSHOT_VERSIONS } from './schema-contract.js';

const snapshotVersionSchema = Joi.number()
	.strict()
	.valid(...SUPPORTED_SNAPSHOT_VERSIONS)
	.required();

const platformFields = {
	directus: Joi.string().when('version', { is: 1, then: Joi.required(), otherwise: Joi.forbidden() }),
	release: Joi.string().when('version', { is: 2, then: Joi.required(), otherwise: Joi.forbidden() }),
};

const snapshotHeaderSchema = Joi.object({ version: snapshotVersionSchema, ...platformFields }).unknown(true);

const snapshotJoiSchema = Joi.object({
	version: snapshotVersionSchema,
	...platformFields,
	vendor: Joi.string()
		.valid(...DatabaseClients)
		.optional(),
	collections: Joi.array().items(
		Joi.object({
			collection: Joi.string(),
			meta: Joi.any(),
			schema: Joi.object({
				name: Joi.string(),
			}),
		})
	),
	fields: Joi.array().items(
		Joi.object({
			collection: Joi.string(),
			field: Joi.string(),
			meta: Joi.any(),
			schema: Joi.object({
				default_value: Joi.any(),
				max_length: [Joi.number(), Joi.string(), Joi.valid(null)],
				is_nullable: Joi.bool(),
			})
				.unknown()
				.allow(null),
			type: Joi.string()
				.valid(...TYPES, ...ALIAS_TYPES)
				.allow(null),
		})
	),
	relations: Joi.array().items(
		Joi.object({
			collection: Joi.string(),
			field: Joi.string(),
			meta: Joi.any(),
			related_collection: Joi.any(),
			schema: Joi.any(),
		})
	),
});

export function validateSnapshotVersion(snapshot: unknown): void {
	const version = isPlainObject(snapshot) ? (snapshot as Record<string, unknown>)['version'] : undefined;
	const { error } = Joi.object({ version: snapshotVersionSchema }).validate({ version });
	if (error) throw new InvalidPayloadException(error.message);
}

export function validateSnapshotHeader(snapshot: unknown): void {
	const { error } = snapshotHeaderSchema.validate(snapshot ?? {});
	if (error) throw new InvalidPayloadException(error.message);
}

function snapshotRelease(snapshot: Snapshot | PortableSnapshot): string {
	return snapshot.version === 2 ? (snapshot as PortableSnapshot).release : (snapshot as Snapshot).directus;
}

/**
 * Validates the snapshot against the current instance.
 **/
export function validateSnapshot(snapshot: Snapshot | PortableSnapshot, force = false) {
	const { error } = snapshotJoiSchema.validate(snapshot);
	if (error) throw new InvalidPayloadException(error.message);

	// Bypass checks when "force" option is enabled
	if (force) return;

	if (snapshotRelease(snapshot) !== currentRelease) {
		throw new InvalidPayloadException(
			`Provided snapshot's CairnCMS version ${snapshotRelease(
				snapshot
			)} does not match the current instance's version ${currentRelease}. You can bypass this check by passing the "force" query parameter.`
		);
	}

	if (!snapshot.vendor) {
		throw new InvalidPayloadException(
			'Provided snapshot does not contain the "vendor" property. You can bypass this check by passing the "force" query parameter.'
		);
	}

	const currentVendor = getDatabaseClient();

	if (snapshot.vendor !== currentVendor) {
		throw new InvalidPayloadException(
			`Provided snapshot's vendor ${snapshot.vendor} does not match the current instance's vendor ${currentVendor}. You can bypass this check by passing the "force" query parameter.`
		);
	}
}
