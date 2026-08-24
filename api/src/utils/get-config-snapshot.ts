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
} from '../types/config.js';
import { makeDependencyAccessor } from './config/dependency-context.js';
import type { RolesKindTypes } from './config/handlers/roles.js';
import { getDescriptor } from './config/registry.js';
import { resolveReadClosure } from './config/scope.js';
import { getSchema } from './get-schema.js';
import { safeLogFragment } from './safe-log-fragment.js';
import { validateConfigRecord } from './validate-desired-config.js';

export type CurrentConfigRead = {
	config: CairnConfig;
	currentRoleKeys: ReadonlySet<string>;
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
		return { config: { manifest, roles: [], permissions: [] }, currentRoleKeys: new Set() };
	}

	const schema = options.schema ?? (await getSchema({ database, bypassCache: true }));
	const published = new Map<ConfigKind, unknown>();
	const documentsByKind = new Map<ConfigKind, unknown[]>();

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

	return { config, currentRoleKeys };
}

export async function getConfigSnapshot(options?: { database?: Knex; schema?: SchemaOverview }): Promise<CairnConfig> {
	const { config } = await readCurrentConfig({ ...options, resources: CONFIG_KINDS });

	return config;
}
