import { BaseException } from '@cairncms/exceptions';
import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { flushCaches } from '../cache.js';
import getDatabase from '../database/index.js';
import emitter from '../emitter.js';
import { ConfigApplyFailedException } from '../exceptions/config-apply-failed.js';
import { ConfigPostCommitFailedException } from '../exceptions/config-post-commit-failed.js';
import { ConfigProtectedRecordException } from '../exceptions/config-protected-record.js';
import { DestructiveChangesRequiredException } from '../exceptions/destructive-changes-required.js';
import type { ActionEventParams } from '../types/index.js';
import type { ApplyResult, ConfigApplySecurityContext, ConfigKind, ConfigPlan } from '../types/config.js';
import { makeDependencyAccessor } from './config/dependency-context.js';
import type { ConfigApplyMutationOptions } from './config/descriptor.js';
import { dependencyClosure, dependencyOrder, reverseDependencyOrder } from './config/graph.js';
import { planDeletions, planHasDeletions } from './config/plan-folds.js';
import { getDescriptor, listConfigKinds } from './config/registry.js';
import { getSchema } from './get-schema.js';

type ApplyOptions = {
	database?: Knex;
	schema?: SchemaOverview;
	destructive?: boolean;
	context: ConfigApplySecurityContext;
};

function sliceActive(slice: { create: unknown[]; update: unknown[]; delete: unknown[] }): boolean {
	return slice.create.length > 0 || slice.update.length > 0 || slice.delete.length > 0;
}

function assembleResult(slices: Map<ConfigKind, unknown>): ApplyResult {
	return Object.fromEntries(
		listConfigKinds().map((kind) => [kind, slices.get(kind) ?? getDescriptor(kind).handler.emptyResult()])
	) as unknown as ApplyResult;
}

export async function applyConfigPlan(plan: ConfigPlan, opts: ApplyOptions): Promise<ApplyResult> {
	const protection = plan.protections[0];

	if (protection) {
		throw new ConfigProtectedRecordException(protection.message, {
			protection: { code: protection.code },
			contributors: protection.contributors,
		});
	}

	const active = listConfigKinds().filter((kind) => sliceActive(plan[kind]));

	if (active.length === 0) return assembleResult(new Map());

	if (!opts.destructive && planHasDeletions(plan)) {
		throw new DestructiveChangesRequiredException(
			'The configuration plan contains deletions. Re-run with the destructive option to authorize them.',
			{ deletions: planDeletions(plan) }
		);
	}

	const database = opts.database ?? getDatabase();
	const schema = opts.schema ?? (await getSchema({ database, bypassCache: true }));
	const nestedActionEvents: ActionEventParams[] = [];

	const mutationOptions: ConfigApplyMutationOptions = {
		autoPurgeCache: false,
		autoPurgeSystemCache: false,
		bypassLimits: true,
		bypassEmitAction: (params) => nestedActionEvents.push(params),
	};

	const closure = dependencyOrder([...dependencyClosure(active, (kind) => getDescriptor(kind).dependencies)]);
	const slices = new Map<ConfigKind, unknown>();

	try {
		await database.transaction(async (trx) => {
			const published = new Map<ConfigKind, unknown>();

			for (const kind of active) slices.set(kind, getDescriptor(kind).handler.emptyResult());

			const contextFor = (kind: ConfigKind) => ({
				database: trx,
				schema,
				securityContext: opts.context,
				mutationOptions,
				dependency: makeDependencyAccessor(getDescriptor(kind).dependencies, published),
			});

			for (const kind of closure) {
				const { handler } = getDescriptor(kind);

				if (active.includes(kind)) {
					if (plan[kind].create.length > 0) {
						const outcome = await handler.applyCreates(plan[kind].create as never, contextFor(kind) as never);
						slices.set(kind, handler.mergeOutcome(slices.get(kind) as never, outcome as never));
					}

					if (plan[kind].update.length > 0) {
						const outcome = await handler.applyUpdates(plan[kind].update as never, contextFor(kind) as never);
						slices.set(kind, handler.mergeOutcome(slices.get(kind) as never, outcome as never));
					}
				}

				published.set(kind, await handler.readApplyDependencyState(contextFor(kind) as never));
			}

			for (const kind of reverseDependencyOrder([...closure])) {
				const { handler } = getDescriptor(kind);

				if (active.includes(kind) && plan[kind].delete.length > 0) {
					const outcome = await handler.applyDeletes(plan[kind].delete as never, contextFor(kind) as never);
					slices.set(kind, handler.mergeOutcome(slices.get(kind) as never, outcome as never));
				}
			}
		});
	} catch (err) {
		if (err instanceof BaseException) throw err;
		throw new ConfigApplyFailedException();
	}

	let cacheError: unknown;

	try {
		await flushCaches();
	} catch (err) {
		cacheError = err;
	}

	// The mutation is committed; still dispatch its action events if cache invalidation fails.
	for (const actionEvent of nestedActionEvents) {
		await emitter.emitActionAndWait(actionEvent.event, actionEvent.meta, actionEvent.context);
	}

	if (cacheError !== undefined) throw new ConfigPostCommitFailedException();

	return assembleResult(slices);
}
