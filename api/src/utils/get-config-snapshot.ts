import type { SchemaOverview } from '@cairncms/types';
import type { Knex } from 'knex';
import getDatabase from '../database/index.js';
import { ConfigReadFailedException } from '../exceptions/config-read-failed.js';
import {
	CONFIG_KINDS,
	type CairnConfig,
	type ConfigKind,
	type ConfigPermissionSet,
	type ConfigRole,
	type ConfigStateToken,
} from '../types/config.js';
import { computeConfigStateDigest, toStateDigestEntry, type StateDigestEntry } from './config/config-state-digest.js';
import { makeDependencyAccessor } from './config/dependency-context.js';
import type { ConfigReadMode } from './config/descriptor.js';
import type { RolesKindTypes } from './config/handlers/roles.js';
import { getDescriptor } from './config/registry.js';
import { resolveReadClosure } from './config/scope.js';
import { getSchema } from './get-schema.js';
import { safeLogFragment } from './safe-log-fragment.js';
import { findPlaceholderSyntax, validateConfigRecord } from './validate-desired-config.js';

export type CurrentConfigRead = {
	config: CairnConfig;
	currentRoleKeys: ReadonlySet<string>;
	stateToken: ConfigStateToken;
};

export type CurrentConfigOptions = {
	database?: Knex;
	schema?: SchemaOverview;
	resources: readonly ConfigKind[];
};

/** Formats a read-diagnostic subject, applying safeLogFragment to the descriptor-supplied value centrally. */
function readSubjectOf<Identity>(
	subjectOf: (identity: Identity) => { label: string; value: string },
	identity: Identity
): string {
	const { label, value } = subjectOf(identity);
	return `${label}=${safeLogFragment(value)}`;
}

/** A composed document that cannot be represented in the config format is a current-state failure, not caller input. */
function assertEmittedDocument(kind: ConfigKind, subject: string, document: unknown): void {
	const problems = validateConfigRecord(kind, document);

	if (problems.length > 0) {
		throw new ConfigReadFailedException(
			`Config snapshot could not read ${subject}: it cannot be represented in the config format (${problems.join(
				'; '
			)}).`
		);
	}
}

export async function readCurrentConfig(options: CurrentConfigOptions): Promise<CurrentConfigRead> {
	const database = options.database ?? getDatabase();
	const manifest = { version: 1 as const, resources: [...options.resources] };
	const managed = new Set<ConfigKind>(options.resources);

	const closure = resolveReadClosure(manifest);

	if (closure.length === 0) {
		return {
			config: { manifest, roles: [], permissions: [] },
			currentRoleKeys: new Set(),
			stateToken: Object.freeze({ resources: Object.freeze([]), digest: computeConfigStateDigest([]) }),
		};
	}

	const schema = options.schema ?? (await getSchema({ database, bypassCache: true }));
	const published = new Map<ConfigKind, unknown>();
	const documentsByKind = new Map<ConfigKind, unknown[]>();
	const projectionInputs: Array<{ kind: ConfigKind; mode: ConfigReadMode; result: unknown }> = [];

	for (const { kind, mode } of closure) {
		const descriptor = getDescriptor(kind);

		const context = {
			database,
			schema,
			readMode: mode,
			dependency: makeDependencyAccessor(descriptor.dependencies, published),
		};

		const result = await descriptor.handler.readCurrent(context as never);
		published.set(kind, result.dependencyState);
		projectionInputs.push({ kind, mode, result });

		if (!managed.has(kind)) continue;

		const documents = descriptor.composeDocuments(result.records as never, result.documentIdentities as never);

		for (const document of documents) {
			const identity = descriptor.layout.documentIdentityOf(document as never);
			const subjectOf = descriptor.emittedDocumentSubject as (identity: unknown) => { label: string; value: string };
			assertEmittedDocument(kind, readSubjectOf(subjectOf, identity), document);
		}

		documentsByKind.set(kind, documents as unknown[]);
	}

	const config: CairnConfig = {
		manifest,
		roles: (documentsByKind.get('roles') ?? []) as ConfigRole[],
		permissions: (documentsByKind.get('permissions') ?? []) as ConfigPermissionSet[],
	};

	const placeholders = findPlaceholderSyntax(config);

	if (placeholders.length > 0) {
		throw new ConfigReadFailedException(
			`Config snapshot could not represent the current state: ${placeholders.join(
				'; '
			)}. The config format substitutes that form on read, so rename the stored value, then retry.`
		);
	}

	const readsRoles = closure.some((entry) => entry.kind === 'roles');
	let currentRoleKeys: ReadonlySet<string> = new Set<string>();

	if (readsRoles) {
		const rolesState = published.get('roles') as RolesKindTypes['ReadDependencyState'] | undefined;

		if (!rolesState) {
			throw new ConfigReadFailedException(
				'Configuration state could not be assembled. Retry the operation and report the failure if it persists.'
			);
		}

		currentRoleKeys = rolesState.currentRoleKeys;
	}

	let stateToken: ConfigStateToken;

	try {
		const entries: StateDigestEntry[] = projectionInputs.map(({ kind, mode, result }) =>
			toStateDigestEntry(kind, mode, getDescriptor(kind).handler.projectReadState(result as never, mode))
		);

		stateToken = Object.freeze({
			resources: Object.freeze(
				closure
					.filter((entry) => entry.mode === 'full')
					.map((entry) => entry.kind)
					.sort()
			),
			digest: computeConfigStateDigest(entries),
		});
	} catch {
		throw new ConfigReadFailedException(
			'Configuration state could not be represented as a state digest. Retry the operation and report the failure if it persists.'
		);
	}

	return { config, currentRoleKeys, stateToken };
}

export async function getConfigSnapshot(options?: { database?: Knex; schema?: SchemaOverview }): Promise<CairnConfig> {
	const { config } = await readCurrentConfig({ ...options, resources: CONFIG_KINDS });

	return config;
}
