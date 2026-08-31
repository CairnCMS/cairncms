import type { Knex } from 'knex';
import type { SchemaOverview } from '@cairncms/types';
import type {
	ConfigApplySecurityContext,
	ConfigFailure,
	ConfigKind,
	ConfigPlanChange,
	ConfigPlanEnrichment,
} from '../../types/config.js';
import type { MutationOptions } from '../../types/index.js';

export type ConfigOperation = 'create' | 'update' | 'delete';

export type ConfigReadMode = 'full' | 'identity';

/**
 * The four config-controlled mutation options. Each literal is intersected with its MutationOptions source, so a
 * removed or widened upstream field fails here. Handlers forward one mutable object so nested mutations share the
 * event sink. Services may add fields such as preMutationException.
 */
export interface ConfigApplyMutationOptions {
	autoPurgeCache: false & NonNullable<MutationOptions['autoPurgeCache']>;
	autoPurgeSystemCache: false & NonNullable<MutationOptions['autoPurgeSystemCache']>;
	bypassLimits: true & NonNullable<MutationOptions['bypassLimits']>;
	bypassEmitAction: NonNullable<MutationOptions['bypassEmitAction']>;
}

export type FieldSensitivity =
	| { secret: false; redact: 'none' }
	| { secret: true; redact: (value: unknown) => unknown };

export interface ConfigFieldDescriptor {
	name: string;
	type: 'string' | 'boolean' | 'string-list' | 'policy-object';
	required: boolean;
	nullable: boolean;
	allowEmpty?: boolean;
	allowEmptyElements?: boolean;
	minLength?: number;
	maxLength?: number;
	enum?: readonly string[];
	grammar?: 'role-key';
	reserved?: readonly string[];
	acceptsPlaceholder: boolean;
	canonicalize?: (value: unknown) => unknown;
	sensitivity: FieldSensitivity;
	snapshotSafe: boolean;
	mutable: boolean;
	omissionPreservesCurrent: boolean;
	/** A record field that is part of the record's identity (e.g. a permission's collection/action), excluded from canonical values. */
	identityComponent?: boolean;
}

export type ConfigDocumentShape = 'flat' | { recordsField: string };

/** A per-kind dependency payload, keyed only by config kinds. */
export type ConfigDependencyMap = Partial<Record<ConfigKind, unknown>>;

/** A kind with no cross-kind dependencies (its dependency accessor cannot be called). */
export type NoConfigDependencies = Record<never, never>;

/** Every associated type of one kind, so the descriptor and handler are declared and constrained end to end. */
export interface ConfigKindTypes {
	Kind: ConfigKind;
	Document: unknown;
	Record: unknown;
	Values: unknown;
	Identity: unknown;
	DocumentIdentity: unknown;
	Create: unknown;
	Update: unknown;
	Delete: unknown;
	Changes: unknown;
	ReadDependencyState: unknown;
	ApplyDependencyState: unknown;
	ReadDependencies: ConfigDependencyMap;
	PlanDependencies: ConfigDependencyMap;
	ApplyDependencies: ConfigDependencyMap;
	Enrichment: Record<string, unknown>;
	ResultSlice: unknown;
	Outcome: { op: ConfigOperation };
}

export type KindPlan<K extends ConfigKindTypes> = {
	create: K['Create'][];
	update: K['Update'][];
	delete: K['Delete'][];
};

export interface ConfigResourceDescriptor<K extends ConfigKindTypes> {
	kind: K['Kind'];
	formatVersion: number;
	dependencies: ConfigKind[];
	layout: {
		directory: string;
		documentShape: ConfigDocumentShape;
		documentIdentityOf(document: K['Document']): K['DocumentIdentity'];
		filenameOf(documentIdentity: K['DocumentIdentity']): string;
		/** Checks an untrusted mapping's file shell (identity presence, kind shape, filename match) and returns a typed document; full field validation happens later in validateDesiredConfig. */
		parseDocumentFile(record: Record<string, unknown>, filename: string): K['Document'];
		/** The rejection message for a reserved filename; required only for a kind whose identity declares reserved stems. */
		reservedFilenameMessage?(filename: string): string;
	};
	documentIdentityFields: ConfigFieldDescriptor[];
	recordFields: ConfigFieldDescriptor[];
	/** Value (non-identityComponent) field names in canonical output order, which may differ from `recordFields` schema order. */
	valueFieldOrder: readonly string[];
	/** Read-diagnostic label and raw value for a document; the engine applies `safeLogFragment` to the value centrally. */
	emittedDocumentSubject(identity: K['DocumentIdentity']): { label: string; value: string };
	projectDocuments(documents: K['Document'][]): { records: K['Record'][]; anchors: K['DocumentIdentity'][] };
	composeDocuments(records: K['Record'][], anchors: K['DocumentIdentity'][]): K['Document'][];
	identityOf(record: K['Record']): K['Identity'];
	identityKey(identity: K['Identity']): string;
	/** Locale ordering of two identities of this kind, for deterministic serialized output. */
	compareIdentity(a: K['Identity'], b: K['Identity']): number;
	identityOfDelete(entry: K['Delete']): K['Identity'];
	canonicalizeValues(record: K['Record']): K['Values'];
	toCreateEntry(record: K['Record']): K['Create'];
	toUpdateEntry(identity: K['Identity'], changes: K['Changes']): K['Update'];
	toDeleteEntry(identity: K['Identity']): K['Delete'];
	handler: ConfigResourceHandler<K>;
}

export interface ReadContext<K extends ConfigKindTypes> {
	database: Knex;
	schema: SchemaOverview;
	readMode: ConfigReadMode;
	/** Typed access to a declared dependency's read state; the engine throws if that dependency was not published. */
	dependency<D extends Extract<keyof K['ReadDependencies'], ConfigKind>>(kind: D): K['ReadDependencies'][D];
}

export interface ValidationContext {
	rolesManaged: boolean;
	declaredRoleKeys: ReadonlySet<string>;
	currentRoleKeys: ReadonlySet<string>;
}

export interface PlanContext<K extends ConfigKindTypes> {
	/** Typed access to a declared dependency's finalized plan; the engine throws if that dependency was not published. */
	dependency<D extends Extract<keyof K['PlanDependencies'], ConfigKind>>(kind: D): K['PlanDependencies'][D];
}

export interface EnrichContext {
	database: Knex;
	schema: SchemaOverview;
}

export interface ApplyContext<K extends ConfigKindTypes> {
	database: Knex;
	schema: SchemaOverview;
	securityContext: ConfigApplySecurityContext;
	mutationOptions: ConfigApplyMutationOptions;
	/** Typed access to a declared dependency's apply state; the engine throws if that dependency was not published. */
	dependency<D extends Extract<keyof K['ApplyDependencies'], ConfigKind>>(kind: D): K['ApplyDependencies'][D];
}

export type ReadCurrentResult<K extends ConfigKindTypes> = {
	records: K['Record'][];
	documentIdentities: K['DocumentIdentity'][];
	dependencyState: K['ReadDependencyState'];
};

/** A read-state projection for the config state digest: identities in either mode, values only in `full`. */
export type ReadStateProjection =
	| { mode: 'full'; identities: string[]; values: Array<[string, unknown]> }
	| { mode: 'identity'; identities: string[] };

export interface ConfigResourceHandler<K extends ConfigKindTypes> {
	readCurrent(context: ReadContext<K>): Promise<ReadCurrentResult<K>>;
	/** Projects the read result into the mode-appropriate digest contribution; `full` must carry values. */
	projectReadState(result: ReadCurrentResult<K>, mode: ConfigReadMode): ReadStateProjection;
	validateDesired(documents: K['Document'][], records: K['Record'][], context: ValidationContext): ConfigFailure[];
	postPlan(plan: KindPlan<K>, context: PlanContext<K>): KindPlan<K>;
	enrich(plan: KindPlan<K>, records: K['Record'][], context: EnrichContext): Promise<K['Enrichment']>;
	emptyEnrichment(): K['Enrichment'];
	toChanges(plan: KindPlan<K>, enrichment: ConfigPlanEnrichment): ConfigPlanChange[];
	applyCreates(creates: K['Create'][], context: ApplyContext<K>): Promise<Extract<K['Outcome'], { op: 'create' }>>;
	applyUpdates(updates: K['Update'][], context: ApplyContext<K>): Promise<Extract<K['Outcome'], { op: 'update' }>>;
	applyDeletes(deletes: K['Delete'][], context: ApplyContext<K>): Promise<Extract<K['Outcome'], { op: 'delete' }>>;
	readApplyDependencyState(context: ApplyContext<K>): Promise<K['ApplyDependencyState']>;
	emptyResult(): K['ResultSlice'];
	mergeOutcome(slice: K['ResultSlice'], outcome: K['Outcome']): K['ResultSlice'];
}
