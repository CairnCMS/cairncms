import { BaseException } from '@cairncms/exceptions';
import express from 'express';
import { isPlainObject } from 'lodash-es';
import { randomUUID } from 'node:crypto';
import getDatabase from '../database/index.js';
import env from '../env.js';
import {
	ConfigIdentityConflictException,
	ConfigInvalidException,
	ConfigUnsupportedVersionException,
	ForbiddenException,
	UnsupportedMediaTypeException,
} from '../exceptions/index.js';
import { respond } from '../middleware/respond.js';
import asyncHandler from '../utils/async-handler.js';
import { applyConfigPlan } from '../utils/apply-config-plan.js';
import { computeConfigPlan } from '../utils/compute-config-plan.js';
import {
	LATEST_MANIFEST_VERSION,
	SUPPORTED_MANIFEST_VERSIONS,
	type ManifestVersion,
} from '../utils/config-contract.js';
import { isPlanEmpty, planSummary } from '../utils/config/plan-folds.js';
import { kindsForVersion } from '../utils/config/registry.js';
import { normalizeToInternal, serializeToWire } from '../utils/config/wire.js';
import {
	CONFIG_RUN_ID_HEADER,
	callerFromAccountability,
	userAgentFrom,
	withConfigRun,
} from '../utils/config/run-record.js';
import {
	buildExtensionDeclarationSnapshot,
	desiredExtensionSubjects,
} from '../utils/config/handlers/extension-settings.js';
import { enrichConfigPlan } from '../utils/enrich-config-plan.js';
import { readCurrentConfig } from '../utils/get-config-snapshot.js';
import { serializeConfigPlan } from '../utils/serialize-config-plan.js';
import { getSchema } from '../utils/get-schema.js';
import { assertConfigValueSafe, parseConfigYaml } from '../utils/parse-config-document.js';
import { safeLogFragment } from '../utils/safe-log-fragment.js';
import { validateConfigManifest, validateDesiredConfig } from '../utils/validate-desired-config.js';
import type { ConfigFailure, ConfigManifest } from '../types/config.js';

const router = express.Router();

router.get(
	'/snapshot',
	asyncHandler(async (req, res, next) => {
		if (req.accountability?.admin !== true) throw new ForbiddenException();

		const { version, resources } = parseSnapshotScope(req.query);
		const { config } = await readCurrentConfig({ resources, manifestVersion: version });

		res.locals['payload'] = { data: serializeToWire(config, version) };
		res.locals['cache'] = false;

		return next();
	}),
	respond
);

const yamlBodyParser = express.text({
	type: ['application/x-yaml', 'application/yaml', 'text/yaml'],
	limit: env['MAX_PAYLOAD_SIZE'],
});

router.post(
	'/apply',
	yamlBodyParser,
	asyncHandler(async (req, res, next) => {
		if (req.accountability?.admin !== true) throw new ForbiddenException();

		const accountability = req.accountability;
		const desired = parseDesiredConfig(req);

		if (!isPlainObject(desired)) {
			throw new ConfigInvalidException(
				'Request body must be a config snapshot object with a manifest and its managed resources.'
			);
		}

		const document = desired as Record<string, unknown>;

		const dryRun = parseApplyFlag(req.query, 'dry_run');
		const destructive = parseApplyFlag(req.query, 'destructive');

		const manifest = validateConfigManifest(document['manifest'], BODY_LABEL);

		const runId = randomUUID();
		res.setHeader(CONFIG_RUN_ID_HEADER, runId);

		await withConfigRun(
			{
				source: 'http',
				caller: callerFromAccountability(accountability),
				userAgent: userAgentFrom(req.headers['user-agent']),
				runId,
				dryRun,
				destructive,
				manifestVersion: manifest.version,
				managedKinds: manifest.resources,
				emit: 'always',
			},
			async (run) => {
				const database = getDatabase();
				const schema = await getSchema({ database, bypassCache: true });

				const extensionSettingsManaged = manifest.resources.includes('extension-settings');

				// Use one declaration snapshot for read, validation, planning, and mutation.
				const extensionDeclarations = extensionSettingsManaged ? await buildExtensionDeclarationSnapshot() : undefined;

				const extensionSettingsSubjects = extensionSettingsManaged
					? desiredExtensionSubjects(document['extension-settings'])
					: undefined;

				const currentCollections = extensionSettingsManaged ? new Set(Object.keys(schema.collections)) : undefined;

				const {
					config: current,
					currentRoleKeys,
					currentFolderKeys,
					currentFolderParents,
					stateToken,
				} = await readCurrentConfig({
					database,
					schema,
					resources: manifest.resources,
					...(extensionSettingsSubjects !== undefined && { extensionSettingsSubjects }),
					...(extensionDeclarations !== undefined && { extensionDeclarations }),
				});

				const failures = validateDesiredConfig(document, {
					label: BODY_LABEL,
					references: 'current-state',
					currentRoleKeys,
					currentFolderKeys,
					currentFolderParents,
					...(extensionDeclarations !== undefined && { extensionDeclarations }),
					...(currentCollections !== undefined && { currentCollections }),
				});

				if (failures.length > 0) throw failures.map(toConfigException);

				const config = normalizeToInternal(manifest, document);

				const plan = computeConfigPlan(
					current,
					config,
					extensionDeclarations !== undefined ? { extensionDeclarations } : undefined
				);

				run.planned(planSummary(plan));

				const enrichment = await enrichConfigPlan(plan, config, { schema, database });
				const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: manifest.version });
				const empty = isPlanEmpty(plan);

				if (dryRun) {
					res.locals['payload'] = { data: serialized };

					return { result: empty ? ('no_changes' as const) : ('planned' as const) };
				}

				const result = await applyConfigPlan(plan, {
					database,
					schema,
					destructive,
					context: { mode: 'request', accountability },
					expectedStateToken: stateToken,
					...(extensionDeclarations !== undefined && { extensionDeclarations }),
				});

				res.locals['payload'] = { data: result, meta: { plan: serialized } };

				return { result: empty ? ('no_changes' as const) : ('applied' as const) };
			}
		);

		return next();
	}),
	respond
);

const BODY_LABEL = 'request body';

function parseApplyFlag(query: Record<string, unknown>, name: 'dry_run' | 'destructive'): boolean {
	const value = query[name];

	if (value === undefined) return false;
	if (value === 'true') return true;
	if (value === 'false') return false;

	throw new ConfigInvalidException(`The "${name}" query parameter must be exactly "true" or "false" when present.`);
}

function parseSnapshotScope(query: Record<string, unknown>): ConfigManifest {
	const requestedVersion = query['manifest_version'];

	if (
		requestedVersion !== undefined &&
		(typeof requestedVersion !== 'string' ||
			!(SUPPORTED_MANIFEST_VERSIONS as readonly number[]).map(String).includes(requestedVersion))
	) {
		throw new ConfigUnsupportedVersionException(
			`Requested manifest version ${safeLogFragment(String(requestedVersion))} is not supported. ` +
				`This engine supports versions ${SUPPORTED_MANIFEST_VERSIONS.join(', ')}.`
		);
	}

	const version = requestedVersion === undefined ? LATEST_MANIFEST_VERSION : Number(requestedVersion);

	const requested = query['resources'];
	let resources: string[];

	if (requested === undefined) {
		resources = [...kindsForVersion(version as ManifestVersion)];
	} else if (typeof requested !== 'string') {
		throw new ConfigInvalidException('The "resources" query parameter must be a single comma-separated value.');
	} else if (requested === '') {
		resources = [];
	} else {
		resources = requested.split(',');

		if (resources.some((kind) => kind.length === 0)) {
			throw new ConfigInvalidException('The "resources" query parameter has an empty member.');
		}
	}

	return validateConfigManifest({ version, resources }, 'snapshot query');
}

function parseDesiredConfig(req: express.Request): unknown {
	if (req.is('application/json')) {
		assertConfigValueSafe(req.body, BODY_LABEL);
		return req.body;
	}

	if (req.is('application/x-yaml') || req.is('application/yaml') || req.is('text/yaml')) {
		return parseConfigYaml(req.body, BODY_LABEL);
	}

	throw new UnsupportedMediaTypeException(`Unsupported Content-Type: ${req.headers['content-type'] ?? '(none)'}`);
}

function toConfigException(failure: ConfigFailure): BaseException {
	switch (failure.code) {
		case 'CONFIG_INVALID':
			return new ConfigInvalidException(failure.message);
		case 'CONFIG_IDENTITY_CONFLICT':
			return new ConfigIdentityConflictException(failure.message);
	}
}

export default router;
