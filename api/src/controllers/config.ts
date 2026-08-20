import { BaseException } from '@cairncms/exceptions';
import express from 'express';
import { isPlainObject } from 'lodash-es';
import getDatabase from '../database/index.js';
import env from '../env.js';
import {
	ConfigIdentityConflictException,
	ConfigInvalidException,
	ConfigProtectedRecordException,
	ForbiddenException,
	UnsupportedMediaTypeException,
} from '../exceptions/index.js';
import { respond } from '../middleware/respond.js';
import asyncHandler from '../utils/async-handler.js';
import { applyConfigPlan } from '../utils/apply-config-plan.js';
import { computeConfigPlan, validateConfigPlan } from '../utils/compute-config-plan.js';
import { enrichConfigPlan } from '../utils/enrich-config-plan.js';
import { getConfigSnapshot, readCurrentConfig } from '../utils/get-config-snapshot.js';
import { serializeConfigPlan } from '../utils/serialize-config-plan.js';
import { getSchema } from '../utils/get-schema.js';
import { assertConfigValueSafe, parseConfigYaml } from '../utils/parse-config-document.js';
import { isPlaceholder } from '../utils/read-config-directory.js';
import { validateConfigManifest, validateDesiredConfig } from '../utils/validate-desired-config.js';
import type { CairnConfig, ConfigFailure, ConfigKind } from '../types/config.js';

const router = express.Router();

router.get(
	'/snapshot',
	asyncHandler(async (req, res, next) => {
		if (req.accountability?.admin !== true) throw new ForbiddenException();

		const config = await getConfigSnapshot();

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

		const database = getDatabase();
		const schema = await getSchema({ database, bypassCache: true });

		const { config: current, currentRoleKeys } = await readCurrentConfig({
			database,
			schema,
			resources: manifest.resources,
		});

		const config = desired as CairnConfig;
		const failures = validateDesiredConfig(config, { label: BODY_LABEL, currentRoleKeys });

		if (failures.length > 0) throw failures.map(toConfigException);

		if (managed.has('roles')) assertNoPlaceholders(config);

		const plan = computeConfigPlan(current, config);

		const currentRoles = new Map(current.roles.map((r) => [r.key, { admin_access: r.admin_access }]));
		const planFailures = validateConfigPlan(plan, config, { currentRoles });

		if (planFailures.length > 0) throw planFailures.map(toConfigException);

		if (dryRun) {
			const enrichment = await enrichConfigPlan(plan, config, { schema, database });
			const serialized = serializeConfigPlan(plan, { enrichment, manifestVersion: manifest.version });

			res.locals['payload'] = { data: serialized };

			return next();
		}

		const result = await applyConfigPlan(plan, { database, schema, destructive });

		res.locals['payload'] = { data: result };

		return next();
	}),
	respond
);

const BODY_LABEL = 'request body';

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
		case 'CONFIG_PROTECTED_RECORD':
			return new ConfigProtectedRecordException(failure.message);
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
