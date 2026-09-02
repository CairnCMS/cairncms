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
import { SUPPORTED_MANIFEST_VERSION } from '../utils/config-contract.js';
import { isPlanEmpty, planSummary } from '../utils/config/plan-folds.js';
import {
	CONFIG_RUN_ID_HEADER,
	callerFromAccountability,
	userAgentFrom,
	withConfigRun,
} from '../utils/config/run-record.js';
import { enrichConfigPlan } from '../utils/enrich-config-plan.js';
import { readCurrentConfig } from '../utils/get-config-snapshot.js';
import { serializeConfigPlan } from '../utils/serialize-config-plan.js';
import { getSchema } from '../utils/get-schema.js';
import { assertConfigValueSafe, parseConfigYaml } from '../utils/parse-config-document.js';
import { isPlaceholder } from '../utils/read-config-directory.js';
import { safeLogFragment } from '../utils/safe-log-fragment.js';
import { validateConfigManifest, validateDesiredConfig } from '../utils/validate-desired-config.js';
import { CONFIG_KINDS, type CairnConfig, type ConfigFailure, type ConfigKind } from '../types/config.js';

const router = express.Router();

router.get(
	'/snapshot',
	asyncHandler(async (req, res, next) => {
		if (req.accountability?.admin !== true) throw new ForbiddenException();

		const resources = parseSnapshotScope(req.query);
		const { config } = await readCurrentConfig({ resources });

		res.locals['payload'] = { data: config };
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
				'Request body must be a CairnConfig object with manifest, roles, and permissions.'
			);
		}

		const document = desired as Record<string, unknown>;

		const dryRun = req.query['dry_run'] === 'true';
		const destructive = req.query['destructive'] === 'true';

		const manifest = validateConfigManifest(document['manifest'], BODY_LABEL);
		const managed = new Set<ConfigKind>(manifest.resources);

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

				const {
					config: current,
					currentRoleKeys,
					stateToken,
				} = await readCurrentConfig({
					database,
					schema,
					resources: manifest.resources,
				});

				const config = desired as CairnConfig;
				const failures = validateDesiredConfig(config, { label: BODY_LABEL, currentRoleKeys });

				if (failures.length > 0) throw failures.map(toConfigException);

				if (managed.has('roles')) assertNoPlaceholders(config);

				const plan = computeConfigPlan(current, config);

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

function parseSnapshotScope(query: Record<string, unknown>): ConfigKind[] {
	const version = query['manifest_version'];

	if (version !== undefined && (typeof version !== 'string' || version !== String(SUPPORTED_MANIFEST_VERSION))) {
		throw new ConfigUnsupportedVersionException(
			`Requested manifest version ${safeLogFragment(String(version))} is not supported. ` +
				`This engine supports version ${SUPPORTED_MANIFEST_VERSION}.`
		);
	}

	const requested = query['resources'];
	let resources: string[];

	if (requested === undefined) {
		resources = [...CONFIG_KINDS];
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

	const manifest = validateConfigManifest({ version: SUPPORTED_MANIFEST_VERSION, resources }, 'snapshot query');

	return [...manifest.resources];
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

function assertNoPlaceholders(config: CairnConfig): void {
	config.roles.forEach((role, index) => {
		for (const field of ['name', 'description'] as const) {
			if (isPlaceholder(role[field])) {
				throw new ConfigInvalidException(
					`roles[${index}].${field} carries placeholder syntax, which this endpoint does not substitute. ` +
						`Send a resolved value.`
				);
			}
		}
	});
}

export default router;
