import express from 'express';
import getDatabase from '../database/index.js';
import env from '../env.js';
import {
	ConfigInvalidException,
	ForbiddenException,
	InvalidPayloadException,
	UnsupportedMediaTypeException,
} from '../exceptions/index.js';
import { respond } from '../middleware/respond.js';
import asyncHandler from '../utils/async-handler.js';
import { applyConfigPlan } from '../utils/apply-config-plan.js';
import { computeConfigPlan, validateConfigPlan } from '../utils/compute-config-plan.js';
import { getConfigSnapshot } from '../utils/get-config-snapshot.js';
import { getSchema } from '../utils/get-schema.js';
import { assertConfigValueSafe, parseConfigYaml } from '../utils/parse-config-document.js';
import { isPlaceholder } from '../utils/read-config-directory.js';
import type { CairnConfig } from '../types/config.js';

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

		const dryRun = req.query['dry_run'] === 'true';
		const destructive = req.query['destructive'] === 'true';

		const database = getDatabase();
		const schema = await getSchema({ database, bypassCache: true });

		const current = await getConfigSnapshot({ database, schema });
		const plan = computeConfigPlan(current, desired);

		const currentRoles = new Map(current.roles.map((r) => [r.key, { admin_access: r.admin_access }]));
		const validation = validateConfigPlan(plan, desired, { currentRoles });

		if (validation.errors.length > 0) {
			res.status(400).json({ errors: validation.errors });
			return;
		}

		const result = await applyConfigPlan(plan, { database, schema, dryRun, destructive });

		res.locals['payload'] = { data: result };

		return next();
	}),
	respond
);

const BODY_LABEL = 'request body';

/**
 * The YAML path shares the config tree's parser, so a document behaves the same on both surfaces. A
 * JSON body cannot carry the values or cycles that parser rejects, but it can still be nested past
 * the supported depth, so it is asserted directly.
 */
function parseDesiredConfig(req: express.Request): CairnConfig {
	let parsed: unknown;

	if (req.is('application/json')) {
		parsed = req.body;
		assertConfigValueSafe(parsed, BODY_LABEL);
	} else if (req.is('application/x-yaml') || req.is('application/yaml') || req.is('text/yaml')) {
		parsed = parseConfigYaml(req.body, BODY_LABEL);
	} else {
		throw new UnsupportedMediaTypeException(`Unsupported Content-Type: ${req.headers['content-type'] ?? '(none)'}`);
	}

	const config = assertCairnConfigShape(parsed);
	assertNoPlaceholders(config);

	return config;
}

/**
 * Placeholders are substituted while reading a config tree, which this surface never does. Storing one
 * literally would leave a role named after an unresolved variable, so callers send resolved values.
 */
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

function assertCairnConfigShape(value: unknown): CairnConfig {
	if (!isPlainObject(value)) {
		throw new InvalidPayloadException(
			'Request body must be a CairnConfig object with manifest, roles, and permissions.'
		);
	}

	if (!isPlainObject(value['manifest'])) {
		throw new InvalidPayloadException('Request body is missing the required "manifest" object.');
	}

	if (!Array.isArray(value['roles'])) {
		throw new InvalidPayloadException('Request body field "roles" must be an array.');
	}

	if (!Array.isArray(value['permissions'])) {
		throw new InvalidPayloadException('Request body field "permissions" must be an array.');
	}

	value['roles'].forEach((role, index) => {
		if (!isPlainObject(role)) {
			throw new InvalidPayloadException(`roles[${index}] must be an object.`);
		}

		if (typeof role['key'] !== 'string') {
			throw new InvalidPayloadException(`roles[${index}] is missing a string "key".`);
		}
	});

	value['permissions'].forEach((set, setIndex) => {
		if (!isPlainObject(set)) {
			throw new InvalidPayloadException(`permissions[${setIndex}] must be an object.`);
		}

		if (typeof set['role'] !== 'string') {
			throw new InvalidPayloadException(`permissions[${setIndex}] is missing a string "role".`);
		}

		if (!Array.isArray(set['permissions'])) {
			throw new InvalidPayloadException(`permissions[${setIndex}].permissions must be an array.`);
		}

		set['permissions'].forEach((perm: unknown, permIndex: number) => {
			if (!isPlainObject(perm)) {
				throw new InvalidPayloadException(`permissions[${setIndex}].permissions[${permIndex}] must be an object.`);
			}

			if (typeof perm['collection'] !== 'string') {
				throw new InvalidPayloadException(
					`permissions[${setIndex}].permissions[${permIndex}] is missing a string "collection".`
				);
			}

			if (typeof perm['action'] !== 'string') {
				throw new InvalidPayloadException(
					`permissions[${setIndex}].permissions[${permIndex}] is missing a string "action".`
				);
			}
		});
	});

	return value as unknown as CairnConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export default router;
