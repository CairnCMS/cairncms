import { BaseException } from '@cairncms/exceptions';
import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import { flushCaches } from '../cache.js';
import { runInBoundSerializable, lifecycleContextFor } from '../database/bound-transaction.js';
import getDatabase from '../database/index.js';
import { isSerializationConflict } from '../database/serialization-error.js';
import emitter from '../emitter.js';
import { ConfigApplyFailedException } from '../exceptions/config-apply-failed.js';
import { ConfigApplyScopeMismatchException } from '../exceptions/config-apply-scope-mismatch.js';
import { ConfigPostCommitFailedException } from '../exceptions/config-post-commit-failed.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import { ConfigStateChangedException } from '../exceptions/config-state-changed.js';
import { ConfigProtectedRecordException } from '../exceptions/config-protected-record.js';
import { DestructiveChangesRequiredException } from '../exceptions/destructive-changes-required.js';
import type {
	ApplyResult,
	ConfigApplySecurityContext,
	ConfigKind,
	ConfigPlan,
	ConfigStateToken,
} from '../types/config.js';
import { makeDependencyAccessor } from './config/dependency-context.js';
import { readCurrentConfig } from './get-config-snapshot.js';
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
	expectedStateToken: ConfigStateToken;
};

function sameResourceSet(a: readonly ConfigKind[], b: readonly ConfigKind[]): boolean {
	const setA = new Set(a);
	const setB = new Set(b);

	if (setA.size !== a.length || setB.size !== b.length) return false;
	if (setA.size !== setB.size) return false;

	for (const kind of setA) {
		if (!setB.has(kind)) return false;
	}

	return true;
}

async function assertStateUnchanged(trx: Knex, schema: SchemaOverview, expected: ConfigStateToken): Promise<void> {
	let current;

	try {
		current = await readCurrentConfig({ database: trx, schema, resources: expected.resources });
	} catch (err) {
		if (err instanceof ConfigReadFailedException) throw new ConfigStateChangedException();
		throw err;
	}

	if (current.stateToken.digest !== expected.digest) throw new ConfigStateChangedException();
}

function sliceActive(slice: { create: unknown[]; update: unknown[]; delete: unknown[] }): boolean {
	return slice.create.length > 0 || slice.update.length > 0 || slice.delete.length > 0;
}

function assembleResult(slices: Map<ConfigKind, unknown>): ApplyResult {
	return Object.fromEntries(
		listConfigKinds().map((kind) => [kind, slices.get(kind) ?? getDescriptor(kind).handler.emptyResult()])
	) as unknown as ApplyResult;
}

export async function applyConfigPlan(plan: ConfigPlan, opts: ApplyOptions): Promise<ApplyResult> {
	if (!sameResourceSet(plan.managedResources, opts.expectedStateToken.resources)) {
		throw new ConfigApplyScopeMismatchException();
	}

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
	const closure = dependencyOrder([...dependencyClosure(active, (kind) => getDescriptor(kind).dependencies)]);
	const slices = new Map<ConfigKind, unknown>();

	try {
		await runInBoundSerializable(
			database,
			async (trx) => {
				const context = lifecycleContextFor(trx)!;

				await assertStateUnchanged(trx, schema, opts.expectedStateToken);

				const mutationOptions: ConfigApplyMutationOptions = {
					autoPurgeCache: false,
					autoPurgeSystemCache: false,
					bypassLimits: true,
					bypassEmitAction: (params) => context.events.push(params),
				};

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
			},
			async (context) => {
				let cacheError: unknown;

				try {
					await flushCaches();
				} catch (err) {
					cacheError = err;
				}

				// The mutation is committed; still dispatch its action events if cache invalidation fails.
				for (const actionEvent of context.events) {
					await emitter.emitActionAndWait(actionEvent.event, actionEvent.meta, actionEvent.context);
				}

				if (cacheError !== undefined) throw new ConfigPostCommitFailedException();
			}
		);
	} catch (err) {
		if (isSerializationConflict(err)) throw new ConfigStateChangedException();
		if (err instanceof BaseException) throw err;
		throw new ConfigApplyFailedException();
	}

	return assembleResult(slices);
}
