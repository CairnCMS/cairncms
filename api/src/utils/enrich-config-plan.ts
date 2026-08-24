import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import type { CairnConfig, ConfigKind, ConfigPlan, ConfigPlanEnrichment } from '../types/config.js';
import { getDescriptor, listConfigKinds } from './config/registry.js';

type EnrichOptions = {
	schema: SchemaOverview;
	database: Knex;
};

function isSliceActive(slice: { create: unknown[]; update: unknown[]; delete: unknown[] }): boolean {
	return slice.create.length > 0 || slice.update.length > 0 || slice.delete.length > 0;
}

export async function enrichConfigPlan(
	plan: ConfigPlan,
	desired: CairnConfig,
	options: EnrichOptions
): Promise<ConfigPlanEnrichment> {
	const managed = new Set<ConfigKind>(desired.manifest.resources);
	const context = { database: options.database, schema: options.schema };
	const fragments = new Map<string, unknown>();

	for (const kind of listConfigKinds()) {
		const descriptor = getDescriptor(kind);
		const active = managed.has(kind) || isSliceActive(plan[kind]);

		const fragment = active
			? await descriptor.handler.enrich(
					plan[kind] as never,
					(managed.has(kind) ? descriptor.projectDocuments(desired[kind] as never).records : []) as never,
					context
			  )
			: descriptor.handler.emptyEnrichment();

		for (const key of Object.keys(fragment)) {
			if (fragments.has(key)) {
				throw new Error(`Config enrichment produced a duplicate fragment key "${key}".`);
			}

			fragments.set(key, (fragment as Record<string, unknown>)[key]);
		}
	}

	return Object.fromEntries(fragments) as unknown as ConfigPlanEnrichment;
}
