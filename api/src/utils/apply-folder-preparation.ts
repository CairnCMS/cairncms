import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import getDatabase from '../database/index.js';
import type { CairnConfig, ConfigApplySecurityContext, ConfigSchemaCollection } from '../types/config.js';
import { applyConfigPlan } from './apply-config-plan.js';
import { reconcileDesiredSchemaSnapshot } from './config/handlers/schema.js';
import { assertFolderPreparationCreationsOnly, buildFolderPreparationPlan } from './folder-preparation.js';
import { referencedFolderKeys } from './folder-references.js';
import { readCurrentConfig } from './get-config-snapshot.js';
import { getSchema } from './get-schema.js';

type FolderPreparationOptions = {
	context: ConfigApplySecurityContext;
	database?: Knex;
	schema?: SchemaOverview;
};

/**
 * Expects a validated, normalized managed config and the captured current schema records for the collector.
 */
export async function applyFolderPreparation(
	desired: CairnConfig,
	currentSchema: ConfigSchemaCollection[],
	options: FolderPreparationOptions
): Promise<readonly string[]> {
	const { desired: reconciled } = reconcileDesiredSchemaSnapshot(currentSchema, desired.schema);
	const referencedKeys = referencedFolderKeys(reconciled.fields);
	if (referencedKeys.size === 0) return [];

	const database = options.database ?? getDatabase();
	const schema = options.schema ?? (await getSchema({ database, bypassCache: true }));

	const { currentFolderKeys, stateToken } = await readCurrentConfig({ database, schema, resources: ['folders'] });

	const plan = buildFolderPreparationPlan({ referencedKeys, declaredFolders: desired.folders, currentFolderKeys });
	assertFolderPreparationCreationsOnly(plan);

	const result = await applyConfigPlan(plan, {
		database,
		schema,
		context: options.context,
		expectedStateToken: stateToken,
	});

	return result.folders.created;
}
