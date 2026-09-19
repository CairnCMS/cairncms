import type { Knex } from 'knex';
import type { ExtensionSettings, SchemaOverview } from '@cairncms/types';
import type {
	ConfigApplySecurityContext,
	ConfigFailure,
	ConfigKind,
	ConfigPlanChange,
	ConfigPlanEnrichment,
	SettingsRetarget,
} from '../../types/config.js';
import type { MutationOptions } from '../../types/index.js';

export type ConfigOperation = 'create' | 'update' | 'delete';

export type ConfigReadMode = 'full' | 'identity';

/** Keep options tied to MutationOptions and share one mutable event sink across nested services. */
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
	type: 'string' | 'boolean' | 'string-list' | 'policy-object' | 'number' | 'json-array';
	required: boolean;
	nullable: boolean;
	allowEmpty?: boolean;
	allowEmptyElements?: boolean;
	/** For a json-array field, requires every element to be a non-null object. Absent leaves elements unconstrained. */
	arrayItems?: 'record';
	minLength?: number;
	maxLength?: number;
	min?: number;
	max?: number;
	enum?: readonly string[];
	grammar?: 'config-key';
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

export type ConfigDocumentShape =
	| 'flat'
	| { recordsField: string }
	| { singleton: { filename: string } }
	| { nestedMap: { globalField: string; collectionsField: string } };

export type ConfigDependencyMap = Partial<Record<ConfigKind, unknown>>;

/** A kind with no cross-kind dependencies (its dependency accessor cannot be called). */
export type NoConfigDependencies = Record<never, never>;

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
		/** Checks file structure and identity. Full field validation happens later in validateDesiredConfig. */
		parseDocumentFile(record: Record<string, unknown>, filename: string): K['Document'];
		/** The rejection message for a reserved filename; required only for a kind whose identity declares reserved stems. */
		reservedFilenameMessage?(filename: string): string;
		/** Checks derived filename ownership before reading the file; required for nestedMap layouts. */
		ownsFilenameStem?(stem: string): boolean;
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
	/** Nested-value alternative to the generic field scan. */
	residualPlaceholders?(documents: K['Document'][]): string[];
	/** Restores nested declarations not covered by acceptsPlaceholder fields. */
	restorePlaceholders?(pending: K['Document'], existing: Record<string, unknown>): K['Document'];
	/** Validates a matching preservation source before any write, without resolving placeholders. */
	validatePreservationSource?(existing: Record<string, unknown>, label: string): void;
	toCreateEntry(record: K['Record']): K['Create'];
	toUpdateEntry(identity: K['Identity'], changes: K['Changes']): K['Update'];
	toDeleteEntry(identity: K['Identity']): K['Delete'];
	handler: ConfigResourceHandler<K>;
}

export interface ReadContext<K extends ConfigKindTypes> {
	database: Knex;
	schema: SchemaOverview;
	readMode: ConfigReadMode;
	/** Absent reads all eligible subjects; an empty set reads none. */
	selectedExtensionSubjects?: ReadonlySet<string>;
	/** Reuse the operation's catalogue; omit during the transaction recheck to detect declaration changes. */
	extensionDeclarations?: ExtensionDeclarationSnapshot;
	/** Typed access to a declared dependency's read state; the engine throws if that dependency was not published. */
	dependency<D extends Extract<keyof K['ReadDependencies'], ConfigKind>>(kind: D): K['ReadDependencies'][D];
}

/** Portable server snapshots resolve references on the server and must validate without target-local state. */
export type ReferenceStateSource =
	| {
			references: 'current-state';
			currentRoleKeys: ReadonlySet<string>;
			currentFolderKeys: ReadonlySet<string>;
			/** Required to resolve folder parents preserved by omission. */
			currentFolderParents?: ReadonlyMap<string, string | null>;
	  }
	| { references: 'server-snapshot' };

/** Captured once per operation; discoveryComplete distinguishes empty success from failed discovery. */
export type ExtensionDeclarationSnapshot = {
	discoveryComplete: boolean;
	eligible: ReadonlyMap<string, ExtensionSettings>;
};

export type ValidationContext = {
	rolesManaged: boolean;
	declaredRoleKeys: ReadonlySet<string>;
	foldersManaged: boolean;
	declaredFolderKeys: ReadonlySet<string>;
	/** Target-only context; omitted when validating a portable server snapshot. */
	extensionDeclarations?: ExtensionDeclarationSnapshot;
	currentCollections?: ReadonlySet<string>;
} & ReferenceStateSource;

export interface PlanContext<K extends ConfigKindTypes> {
	/** Typed access to a declared dependency's finalized plan; the engine throws if that dependency was not published. */
	dependency<D extends Extract<keyof K['PlanDependencies'], ConfigKind>>(kind: D): K['PlanDependencies'][D];
	/** Includes empty subject documents, which still manage stored keys. */
	desiredSubjects?: ReadonlySet<string>;
	extensionDeclarations?: ExtensionDeclarationSnapshot;
}

export interface EnrichContext {
	database: Knex;
	schema: SchemaOverview;
	/** The default-folder retarget the plan performs, so the folders deletion preview can drop a blocker the same apply clears. */
	settingsRetarget?: SettingsRetarget;
}

export interface ApplyContext<K extends ConfigKindTypes> {
	database: Knex;
	schema: SchemaOverview;
	securityContext: ConfigApplySecurityContext;
	mutationOptions: ConfigApplyMutationOptions;
	extensionDeclarations?: ExtensionDeclarationSnapshot;
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
