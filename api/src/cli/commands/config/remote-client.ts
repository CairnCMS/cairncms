import type { AxiosInstance, Method } from 'axios';
import { isPlainObject } from 'lodash-es';
import { ConfigInvalidException } from '../../../exceptions/config-invalid.js';
import { ConfigUnsupportedVersionException } from '../../../exceptions/config-unsupported-version.js';
import type { CairnConfig, ConfigKind } from '../../../types/config.js';
import { serializeToWire } from '../../../utils/config/wire.js';
import {
	CONFIG_RUN_ID_HEADER,
	type ConfigRunStepFailure,
	type ConfigRunSteps,
	type ConfigStepStatus,
} from '../../../utils/config/run-record.js';
import { listConfigKinds } from '../../../utils/config/registry.js';
import { isValidUuid } from '../../../utils/is-valid-uuid.js';
import { replaceControlCharacters, safeLogFragment } from '../../../utils/safe-log-fragment.js';
import { validateDesiredConfig } from '../../../utils/validate-desired-config.js';
import { resolveEndpoint, type OperatorRemoteTarget } from './operator-remote-target.js';
import {
	RemoteApplyResult,
	RemoteConfigPlan,
	RemoteErrorEntry,
	RemoteErrorEnvelope,
	RemoteErrorExtensions,
	RemoteRunFailure,
	RemoteRunOutcome,
	type RemotePhaseDetail,
	type RemoteWireFailure,
	type RemoteWireOutcome,
	type RemoteWirePlan,
	type RemoteWireResult,
} from './remote-response-schema.js';
import {
	renderDeletions,
	renderProtectionContributors,
	renderStepFailure,
	renderStepOutcome,
	type RenderableDeletion,
} from './render-config-plan.js';

export const REMOTE_CONFIG_MIN_VERSION = '1.6.0';

const REMOTE_SCHEMA_MIN_VERSION = '1.7.0';

const SCHEMA_CHANGE_KINDS: ReadonlySet<string> = new Set(['collections', 'fields', 'relations']);

const SNAPSHOT_LABEL = 'the snapshot response';

const RUN_ID_HEADER = CONFIG_RUN_ID_HEADER.toLowerCase();

const UNKNOWN_OUTCOME_NOTE =
	' The server may have already applied the change; re-snapshot to verify the current state.';

export class RemoteClientError extends Error {
	readonly exitCode: 2 | 3;
	readonly runId: string | undefined;

	constructor(message: string, exitCode: 2 | 3, runId?: string) {
		super(message);
		this.exitCode = exitCode;
		this.runId = runId;
	}
}

export type RemoteSession = {
	transport: AxiosInstance;
	target: OperatorRemoteTarget;
	token: string;
};

type Envelope = { data: unknown; meta: unknown; runId: string | undefined };

function runIdFrom(headers: unknown): string | undefined {
	if (headers === null || typeof headers !== 'object') return undefined;

	const value = (headers as Record<string, unknown>)[RUN_ID_HEADER];

	return typeof value === 'string' && isValidUuid(value) ? value : undefined;
}

function withRunId<T extends object>(value: T, runId: string | undefined): T & { runId?: string } {
	return runId === undefined ? value : { ...value, runId };
}

function attachRunId(err: unknown, runId: string | undefined, note = ''): unknown {
	if (!(err instanceof RemoteClientError)) return err;
	if (runId === undefined && note === '') return err;

	return new RemoteClientError(`${err.message}${note}`, err.exitCode, runId);
}

type RunFailure =
	| { kind: 'absent' }
	| { kind: 'malformed' }
	| { kind: 'reported'; steps: ConfigRunSteps; failure?: ConfigRunStepFailure };

const UNSETTLED_STATUSES: ReadonlySet<ConfigStepStatus> = new Set(['failed', 'rolled_back', 'unknown']);

const STEP_ORDER: ReadonlyArray<keyof ConfigRunSteps> = ['folders', 'schema', 'configuration'];

type WireFailureDetail = NonNullable<NonNullable<RemoteWireFailure['failure']>['detail']>;

function isPhaseDetail(detail: WireFailureDetail): detail is RemotePhaseDetail {
	return Object.hasOwn(detail, 'phase');
}

function projectedFailure(parsed: NonNullable<RemoteWireFailure['failure']>): ConfigRunStepFailure {
	const detail = parsed.detail;
	if (detail === undefined) return { step: parsed.step };
	if (isPhaseDetail(detail)) return { step: parsed.step, detail: { phase: detail.phase } };

	const foreignKeys = detail.foreignKeysRestored === false ? { foreignKeysRestored: false as const } : {};

	if (detail.persisted === 'unknown') return { step: parsed.step, detail: { persisted: 'unknown', ...foreignKeys } };

	const { collections, fields, relations } = detail.persisted;

	return {
		step: parsed.step,
		detail: {
			persisted: {
				collections: collections.map(({ collection, operation, table, metadata }) => ({
					collection,
					operation,
					table,
					metadata,
				})),
				fields: fields.map(({ collection, field, operation, column, metadata }) => ({
					collection,
					field,
					operation,
					column,
					metadata,
				})),
				relations: relations.map(({ collection, field, operation, foreignKey, metadata }) => ({
					collection,
					field,
					operation,
					foreignKey,
					metadata,
				})),
			},
			...foreignKeys,
		},
	};
}

/**
 * The server runs the steps in order and stops at the first failure: a configuration-only run fails only in its
 * configuration step, steps before the failing one settled as skipped or committed, and later steps never ran.
 */
function sequenceHolds(
	steps: ConfigRunSteps,
	failure: ConfigRunStepFailure | undefined,
	schemaManaged: boolean
): boolean {
	if (failure === undefined) return STEP_ORDER.every((step) => steps[step] === 'not_run');

	const status = steps[failure.step];
	if (!UNSETTLED_STATUSES.has(status) && status !== 'committed') return false;

	const index = STEP_ORDER.indexOf(failure.step);

	return STEP_ORDER.every((step, position) => {
		if (position > index) return steps[step] === 'not_run';
		if (position === index) return true;
		return schemaManaged ? steps[step] === 'skipped' || steps[step] === 'committed' : steps[step] === 'not_run';
	});
}

function detailMatchesStatus(failure: ConfigRunStepFailure, steps: ConfigRunSteps): boolean {
	const status = steps[failure.step];
	const detail = failure.detail;

	if (detail === undefined) return true;
	if ('phase' in detail) return status === 'committed';
	return status === (detail.persisted === 'unknown' ? 'unknown' : 'failed');
}

/** The server attaches `steps`, and `failure` once a step has started, to the first error of a failed run. */
function runFailureOf(data: unknown, schemaManaged: boolean): RunFailure {
	const envelope = RemoteErrorEnvelope.safeParse(data);
	if (!envelope.success) return { kind: 'absent' };

	const first = envelope.data.errors[0];
	const extensions = isPlainObject(first) ? (first as Record<string, unknown>)['extensions'] : undefined;
	if (!isPlainObject(extensions)) return { kind: 'absent' };

	const fields = extensions as Record<string, unknown>;
	if (fields['steps'] === undefined && fields['failure'] === undefined) return { kind: 'absent' };

	const parsed = RemoteRunFailure.safeParse({ steps: fields['steps'], failure: fields['failure'] });
	if (!parsed.success) return { kind: 'malformed' };

	const { folders, schema, configuration } = parsed.data.steps;
	const steps: ConfigRunSteps = { folders, schema, configuration };
	const failure = parsed.data.failure === undefined ? undefined : projectedFailure(parsed.data.failure);

	if (!sequenceHolds(steps, failure, schemaManaged)) return { kind: 'malformed' };
	if (failure === undefined) return { kind: 'reported', steps };
	if (!schemaManaged && failure.step !== 'configuration') return { kind: 'malformed' };

	return detailMatchesStatus(failure, steps) ? { kind: 'reported', steps, failure } : { kind: 'malformed' };
}

function persistedFacets(failure: ConfigRunStepFailure | undefined): string[] {
	const detail = failure?.detail;
	if (detail === undefined || !('persisted' in detail) || detail.persisted === 'unknown') return [];

	const { collections, fields, relations } = detail.persisted;

	return [
		...collections.flatMap((entry) => [entry.table, entry.metadata]),
		...fields.flatMap((entry) => [entry.column, entry.metadata]),
		...relations.flatMap((entry) => [entry.foreignKey, entry.metadata]),
	];
}

/**
 * A failed step without persisted detail on a server error leaves its writes unaccounted for, so it is treated as
 * uncertain even though the server labels it failed.
 */
function failureOutcome(
	run: Extract<RunFailure, { kind: 'reported' }>,
	refusal: boolean
): { changed: boolean; uncertain: boolean } {
	const statuses = [run.steps.folders, run.steps.schema, run.steps.configuration];
	const facets = persistedFacets(run.failure);
	const detail = run.failure?.detail;
	const persistedUnknown = detail !== undefined && 'persisted' in detail && detail.persisted === 'unknown';
	const failedStep = run.failure === undefined ? undefined : run.steps[run.failure.step];

	return {
		changed: statuses.some((status) => status === 'committed' || status === 'unknown') || facets.includes('applied'),
		uncertain:
			statuses.includes('unknown') ||
			persistedUnknown ||
			facets.includes('unknown') ||
			(!refusal && failedStep === 'failed' && !(detail !== undefined && 'persisted' in detail)),
	};
}

function redactedFailure(failure: ConfigRunStepFailure, token: string): ConfigRunStepFailure {
	const detail = failure.detail;
	if (detail === undefined || !('persisted' in detail) || detail.persisted === 'unknown') return failure;

	const { collections, fields, relations } = detail.persisted;

	return {
		step: failure.step,
		detail: {
			...detail,
			persisted: {
				collections: collections.map((entry) => ({ ...entry, collection: redactToken(entry.collection, token) })),
				fields: fields.map((entry) => ({
					...entry,
					collection: redactToken(entry.collection, token),
					field: redactToken(entry.field, token),
				})),
				relations: relations.map((entry) => ({
					...entry,
					collection: redactToken(entry.collection, token),
					field: redactToken(entry.field, token),
				})),
			},
		},
	};
}

async function request(
	session: RemoteSession,
	method: Method,
	endpoint: string,
	options: { query?: Record<string, string>; body?: unknown; mutating?: boolean; schemaManaged?: boolean } = {}
): Promise<Envelope> {
	const url = resolveEndpoint(session.target, endpoint);
	const outcome = options.mutating ? UNKNOWN_OUTCOME_NOTE : '';

	let response;

	try {
		response = await session.transport.request({
			method,
			url: url.href,
			headers: { Authorization: `Bearer ${session.token}` },
			...(options.query !== undefined ? { params: options.query } : {}),
			data: options.body,
			responseType: 'json',
			validateStatus: () => true,
		});
	} catch (err) {
		throw new RemoteClientError(
			`Could not reach the server: ${sanitize(transportMessage(err), session.token)}.${outcome}`,
			3
		);
	}

	const runId = runIdFrom(response.headers);

	if (response.status < 200 || response.status >= 300) {
		const refusal = response.status >= 400 && response.status < 500;
		const label = response.status >= 400 ? 'rejected the request' : 'returned an unexpected redirect';
		const run = runFailureOf(response.data, options.schemaManaged === true);
		let exitCode: 2 | 3;
		let uncertain: boolean;
		let detail = '';

		if (run.kind === 'absent') {
			exitCode = refusal ? 2 : 3;
			uncertain = !refusal;
		} else if (run.kind === 'malformed') {
			exitCode = 3;
			uncertain = true;
			detail = '\nThe server reported a step outcome that could not be verified.';
		} else {
			const reported = failureOutcome(run, refusal);
			exitCode = reported.changed || reported.uncertain || !refusal ? 3 : 2;
			uncertain = reported.uncertain;

			const started = [run.steps.folders, run.steps.schema, run.steps.configuration].some(
				(status) => status !== 'not_run'
			);

			if (options.schemaManaged && started) {
				detail = `\n${renderStepOutcome(run.steps)}`;
				if (run.failure !== undefined) detail += `\n${renderStepFailure(redactedFailure(run.failure, session.token))}`;
			}
		}

		let note = '';
		if (options.mutating && uncertain) note = detail === '' ? outcome : `\n${outcome.trimStart()}`;

		throw new RemoteClientError(
			`The server ${label} (${response.status}): ${serverErrorMessage(response.data, session.token)}${detail}${note}`,
			exitCode,
			runId
		);
	}

	if (!isPlainObject(response.data)) {
		throw new RemoteClientError(`The server returned a response that was not valid JSON.${outcome}`, 3, runId);
	}

	return {
		data: (response.data as Record<string, unknown>)['data'],
		meta: (response.data as Record<string, unknown>)['meta'],
		runId,
	};
}

export async function fetchServerVersion(session: RemoteSession): Promise<string> {
	const { data } = await request(session, 'GET', 'server/info');
	const version = isPlainObject(data) ? (data as any).cairncms?.version : undefined;

	if (typeof version !== 'string' || version.length === 0) {
		throw new RemoteClientError('The server did not report a version; the token may lack admin access.', 3);
	}

	return version;
}

export function assertServerSupportsRemoteConfig(version: string, token: string): void {
	assertServerVersion(version, token, REMOTE_CONFIG_MIN_VERSION, 'remote config');
}

export function assertServerSupportsRemoteSchema(version: string, token: string): void {
	assertServerVersion(version, token, REMOTE_SCHEMA_MIN_VERSION, 'a remote apply of a tree that manages schema');
}

function assertServerVersion(version: string, token: string, floor: string, subject: string): void {
	const shown = sanitize(version, token);
	let ok: boolean;

	try {
		ok = meetsMinVersion(version, floor);
	} catch {
		throw new RemoteClientError(`The server reported an unrecognized version "${shown}".`, 3);
	}

	if (!ok) {
		throw new RemoteClientError(`The server is version ${shown}; ${subject} requires ${floor} or newer.`, 2);
	}
}

export async function fetchRemoteSnapshot(
	session: RemoteSession,
	scope: { manifestVersion: number; resources: readonly ConfigKind[] }
): Promise<CairnConfig> {
	const { data } = await request(session, 'GET', 'config/snapshot', {
		query: { manifest_version: String(scope.manifestVersion), resources: scope.resources.join(',') },
	});

	assertSnapshotShape(data, scope);

	return validatedSnapshot(data, session.token);
}

export type RemotePlanOutcome = { plan: RemoteWirePlan; runId?: string };

/**
 * `result` is `null` when a schema-managed run's configuration step did not commit. `steps` is absent only for a
 * configuration-only tree answered by a server that predates the step outcome.
 */
export type RemoteApplyOutcome = {
	plan: RemoteWirePlan;
	result: RemoteWireResult | null;
	steps?: ConfigRunSteps;
	runId?: string;
};

type ApplyOptions = { destructive: boolean; forceSchema?: boolean };

export async function applyRemote(
	session: RemoteSession,
	body: CairnConfig,
	options: ApplyOptions & { dryRun: true }
): Promise<RemotePlanOutcome>;
export async function applyRemote(
	session: RemoteSession,
	body: CairnConfig,
	options: ApplyOptions & { dryRun: false }
): Promise<RemoteApplyOutcome>;
export async function applyRemote(
	session: RemoteSession,
	body: CairnConfig,
	options: ApplyOptions & { dryRun: boolean }
): Promise<RemotePlanOutcome | RemoteApplyOutcome>;
export async function applyRemote(
	session: RemoteSession,
	body: CairnConfig,
	options: ApplyOptions & { dryRun: boolean }
): Promise<RemotePlanOutcome | RemoteApplyOutcome> {
	const query: Record<string, string> = {};
	if (options.dryRun) query['dry_run'] = 'true';
	if (options.destructive) query['destructive'] = 'true';
	if (options.forceSchema) query['force_schema'] = 'true';

	const { data, meta, runId } = await request(session, 'POST', 'config/apply', {
		query,
		body: serializeToWire(body, body.manifest.version),
		mutating: !options.dryRun,
		schemaManaged: managesSchema(body),
	});

	if (options.dryRun) {
		let plan: RemoteWirePlan;

		try {
			plan = validatedPlan(data, body);
		} catch (err) {
			throw attachRunId(err, runId);
		}

		return withRunId({ plan }, runId);
	}

	try {
		const fields = isPlainObject(meta) ? (meta as Record<string, unknown>) : {};
		const schemaManaged = managesSchema(body);
		const outcome = validatedOutcome(fields, schemaManaged);
		const result = validatedApplyData(data, outcome, schemaManaged);
		const plan = validatedPlan(fields['plan'], body);
		assertNoProtections(plan);
		if (outcome !== undefined) assertStepsMatchPlan(plan, outcome.steps, body);
		if (result !== null) assertResultWithinManifest(result, body);
		if (!schemaManaged && result !== null) assertResultMatchesPlan(plan, result);

		return withRunId({ plan, result, ...(outcome !== undefined && { steps: outcome.steps }) }, runId);
	} catch (err) {
		throw attachRunId(err, runId, UNKNOWN_OUTCOME_NOTE);
	}
}

function managesSchema(config: CairnConfig): boolean {
	return config.manifest.resources.includes('schema');
}

function validatedOutcome(meta: Record<string, unknown>, schemaManaged: boolean): RemoteWireOutcome | undefined {
	if (meta['result'] === undefined && meta['steps'] === undefined) {
		if (schemaManaged) throw malformed('apply', 'a schema-managed apply must report its step outcome');
		return undefined;
	}

	const parsed = RemoteRunOutcome.safeParse({ result: meta['result'], steps: meta['steps'] });
	if (!parsed.success) throw malformed('apply outcome');

	const { result, steps } = parsed.data;
	const committed = [steps.folders, steps.schema, steps.configuration].includes('committed');

	if ((result === 'applied') !== committed) {
		throw new RemoteClientError('The server reported an apply outcome that does not match its steps.', 3);
	}

	return parsed.data;
}

/** Folder preparation and the configuration step re-read the target, so only the schema step is bound to the preview. */
function assertStepsMatchPlan(plan: RemoteWirePlan, steps: ConfigRunSteps, submitted: CairnConfig): void {
	const schemaChanges = plan.changes.some((change) => SCHEMA_CHANGE_KINDS.has(change.kind));
	const ran = (status: string) => status === 'committed' || status === 'skipped';
	let consistent: boolean;

	if (managesSchema(submitted)) {
		const resources = submitted.manifest.resources;
		const configurationManaged = resources.some((kind) => kind !== 'schema');

		consistent =
			ran(steps.folders) &&
			(resources.includes('folders') || steps.folders === 'skipped') &&
			steps.schema === (schemaChanges ? 'committed' : 'skipped') &&
			ran(steps.configuration) &&
			(configurationManaged || steps.configuration === 'skipped');
	} else {
		consistent =
			steps.folders === 'not_run' &&
			steps.schema === 'not_run' &&
			steps.configuration === (plan.changes.length > 0 ? 'committed' : 'skipped');
	}

	if (!consistent) throw new RemoteClientError('The server reported step outcomes that do not match its plan.', 3);
}

function validatedApplyData(
	data: unknown,
	outcome: RemoteWireOutcome | undefined,
	schemaManaged: boolean
): RemoteWireResult | null {
	if (schemaManaged && outcome?.steps.configuration !== 'committed') {
		if (data !== null) {
			throw new RemoteClientError(
				'The server reported a configuration result for a configuration step that did not commit.',
				3
			);
		}

		return null;
	}

	return validatedResult(data);
}

function validatedPlan(plan: unknown, submitted: CairnConfig): RemoteWirePlan {
	const schemaManaged = managesSchema(submitted);

	if (isPlainObject(plan)) {
		const declared = (plan as Record<string, unknown>)['planVersion'];

		if (declared !== undefined && declared !== (schemaManaged ? 3 : 2)) {
			throw new RemoteClientError('The server returned an unsupported plan version.', 3);
		}
	}

	const parsed = RemoteConfigPlan.safeParse(plan);
	if (!parsed.success) throw malformed('plan');

	const wire = parsed.data;
	const managed = new Set<string>(submitted.manifest.resources);

	if (
		wire.manifestVersion !== submitted.manifest.version ||
		wire.changes.some((change) => !managed.has(SCHEMA_CHANGE_KINDS.has(change.kind) ? 'schema' : change.kind))
	) {
		throw new RemoteClientError('The server returned a plan for a different manifest than the one submitted.', 3);
	}

	const counted = countOperations(wire.changes);

	if (
		counted.create !== wire.summary.create ||
		counted.update !== wire.summary.update ||
		counted.delete !== wire.summary.delete
	) {
		throw new RemoteClientError('The server returned a plan whose summary does not match its changes.', 3);
	}

	assertPreparationInPlan(wire, schemaManaged);

	return wire;
}

function assertPreparationInPlan(wire: RemoteWirePlan, schemaManaged: boolean): void {
	if (wire.preparation === undefined) return;

	const created = new Set<string>();

	for (const change of wire.changes) {
		if (change.kind === 'folders' && change.operation === 'create') created.add(change.identity.key);
	}

	if (
		!schemaManaged ||
		new Set(wire.preparation).size !== wire.preparation.length ||
		wire.preparation.some((key) => !created.has(key))
	) {
		throw malformed('plan', 'folder preparation must name folders the plan creates');
	}
}

function validatedResult(result: unknown): RemoteWireResult {
	const parsed = RemoteApplyResult.safeParse(result);
	if (!parsed.success) throw malformed('result');

	return parsed.data;
}

function resultCardinality(kind: ConfigKind, result: RemoteWireResult): Record<'create' | 'update' | 'delete', number> {
	switch (kind) {
		case 'roles':
			return {
				create: result.roles.created.length,
				update: result.roles.updated.length,
				delete: result.roles.deleted.length,
			};

		case 'permissions':
			return {
				create: result.permissions.created,
				update: result.permissions.updated,
				delete: result.permissions.deleted,
			};

		case 'folders':
			return {
				create: result.folders.created.length,
				update: result.folders.updated.length,
				delete: result.folders.deleted.length,
			};

		case 'settings':
			return {
				create: 0,
				update: result.settings.updated.length,
				delete: 0,
			};

		case 'extension-settings':
			return {
				create: result['extension-settings'].created,
				update: result['extension-settings'].updated,
				delete: result['extension-settings'].deleted,
			};

		case 'translations':
			return {
				create: result.translations.created,
				update: result.translations.updated,
				delete: result.translations.deleted,
			};

		case 'schema':
			return { create: 0, update: 0, delete: 0 };

		default: {
			const unhandled: never = kind;
			throw new Error(`Unhandled config kind: ${JSON.stringify(unhandled)}`);
		}
	}
}

function assertNoProtections(plan: RemoteWirePlan): void {
	if (plan.protections.length > 0) {
		throw new RemoteClientError(
			'The server reported a successful apply but its plan still lists protected changes.',
			3
		);
	}
}

function assertResultWithinManifest(result: RemoteWireResult, submitted: CairnConfig): void {
	const managed = new Set<ConfigKind>(submitted.manifest.resources);

	for (const kind of listConfigKinds()) {
		if (managed.has(kind)) continue;

		const counted = resultCardinality(kind, result);

		if (counted.create !== 0 || counted.update !== 0 || counted.delete !== 0) {
			throw new RemoteClientError('The server reported a result for a kind the submitted manifest does not manage.', 3);
		}
	}
}

function assertResultMatchesPlan(plan: RemoteWirePlan, result: RemoteWireResult): void {
	for (const kind of listConfigKinds()) {
		const planned = countOperations(plan.changes, kind);
		const actual = resultCardinality(kind, result);

		if (actual.create !== planned.create || actual.update !== planned.update || actual.delete !== planned.delete) {
			throw new RemoteClientError('The server reported a result that does not match its plan.', 3);
		}
	}
}

function countOperations(
	changes: RemoteWirePlan['changes'],
	kind?: ConfigKind
): Record<'create' | 'update' | 'delete', number> {
	const counted = { create: 0, update: 0, delete: 0 };

	for (const change of changes) {
		if (kind === undefined || change.kind === kind) counted[change.operation]++;
	}

	return counted;
}

function validatedSnapshot(data: unknown, token: string): CairnConfig {
	let failures: string[];

	try {
		failures = validateDesiredConfig(data, { label: SNAPSHOT_LABEL, references: 'server-snapshot' }).map(
			(failure) => failure.message
		);
	} catch (err) {
		if (!(err instanceof ConfigInvalidException) && !(err instanceof ConfigUnsupportedVersionException)) throw err;
		failures = [err.message];
	}

	if (failures.length > 0) throw malformed('snapshot', diagnostic(failures[0]!, token));

	const snapshot = data as CairnConfig;
	const managed = new Set<ConfigKind>(snapshot.manifest.resources);
	const provenance = snapshot.manifest.schema;

	if (managed.has('schema') && provenance === undefined) {
		throw malformed('snapshot', 'a schema-managing snapshot must record its schema provenance');
	}

	return {
		manifest: {
			version: snapshot.manifest.version,
			resources: [...snapshot.manifest.resources],
			...(provenance !== undefined && { schema: { release: provenance.release, vendor: provenance.vendor } }),
		},
		roles: managed.has('roles') ? snapshot.roles : [],
		permissions: managed.has('permissions') ? snapshot.permissions : [],
		folders: managed.has('folders') ? snapshot.folders : [],
		settings: managed.has('settings') ? snapshot.settings : [],
		'extension-settings': managed.has('extension-settings') ? snapshot['extension-settings'] : [],
		translations: managed.has('translations') ? snapshot.translations : [],
		schema: managed.has('schema') ? snapshot.schema : [],
	};
}

function diagnostic(text: string, token: string): string {
	return safeLogFragment(sanitize(text, token));
}

function assertSnapshotShape(
	data: unknown,
	scope: { manifestVersion: number; resources: readonly ConfigKind[] }
): void {
	if (!isPlainObject(data)) throw malformed('snapshot');

	const manifest = (data as Record<string, unknown>)['manifest'];

	if (!isPlainObject(manifest) || (manifest as Record<string, unknown>)['version'] !== scope.manifestVersion) {
		throw malformed('snapshot manifest version');
	}

	const returned = (manifest as Record<string, unknown>)['resources'];

	if (!Array.isArray(returned) || !sameKinds(returned, scope.resources)) {
		throw malformed('snapshot scope');
	}
}

function sameKinds(returned: unknown[], requested: readonly ConfigKind[]): boolean {
	if (returned.length !== requested.length) return false;
	const set = new Set(returned);
	return requested.every((kind) => set.has(kind));
}

function malformed(what: string, detail?: string): RemoteClientError {
	const suffix = detail === undefined ? '' : ` (${detail})`;
	return new RemoteClientError(`The server returned a malformed ${what} response${suffix}.`, 3);
}

function redactToken(text: string, token: string): string {
	if (token.length === 0) return text;

	const neutralized = replaceControlCharacters(token);
	let redacted = text.split(token).join('[redacted]');
	if (neutralized !== token) redacted = redacted.split(neutralized).join('[redacted]');

	return redacted;
}

function redactedDeletion(deletion: RenderableDeletion, token: string): RenderableDeletion {
	if (deletion.kind === 'roles') {
		return { kind: 'roles', identity: { key: redactToken(deletion.identity.key, token) } };
	}

	if (deletion.kind === 'permissions') {
		const { role, collection, action } = deletion.identity;

		return {
			kind: 'permissions',
			identity: {
				role: redactToken(role, token),
				collection: redactToken(collection, token),
				action: redactToken(action, token),
			},
		};
	}

	if (deletion.kind === 'folders') {
		return { kind: 'folders', identity: { key: redactToken(deletion.identity.key, token) } };
	}

	if (deletion.kind === 'extension-settings') {
		const { subject, scope, scope_key, key } = deletion.identity;

		return {
			kind: 'extension-settings',
			identity: {
				subject: redactToken(subject, token),
				scope,
				scope_key: redactToken(scope_key, token),
				key: redactToken(key, token),
			},
		};
	}

	if (deletion.kind === 'translations') {
		const { language, key } = deletion.identity;

		return { kind: 'translations', identity: { language: redactToken(language, token), key: redactToken(key, token) } };
	}

	if (deletion.kind === 'schema') {
		return { kind: 'schema', identity: { collection: redactToken(deletion.identity.collection, token) } };
	}

	const unhandled: never = deletion;
	throw new Error(`Unhandled config kind: ${JSON.stringify(unhandled)}`);
}

function sanitize(text: string, token: string): string {
	return replaceControlCharacters(redactToken(text, token));
}

function serverErrorMessage(data: unknown, token: string): string {
	const envelope = RemoteErrorEnvelope.safeParse(data);
	if (!envelope.success) return 'no error detail was provided.';

	const lines: string[] = [];

	for (const raw of envelope.data.errors) {
		const entry = RemoteErrorEntry.safeParse(raw);
		if (!entry.success) continue;

		lines.push(sanitize(entry.data.message, token));

		const extensions = RemoteErrorExtensions.safeParse(entry.data['extensions']);
		if (!extensions.success) continue;

		if (extensions.data.code === 'DESTRUCTIVE_CHANGES_REQUIRED') {
			lines.push(...renderDeletions(extensions.data.deletions.map((deletion) => redactedDeletion(deletion, token))));
		} else {
			lines.push(
				...renderProtectionContributors(
					extensions.data.contributors.map((contributor) => ({
						...contributor,
						identity: { ...contributor.identity, key: redactToken(contributor.identity.key, token) },
					}))
				)
			);
		}
	}

	return lines.length > 0 ? lines.join('\n') : 'no error detail was provided.';
}

function transportMessage(err: unknown): string {
	const code = (err as { code?: unknown }).code;
	if (typeof code === 'string' && code.length > 0) return code;

	const message = (err as { message?: unknown }).message;
	return typeof message === 'string' && message.length > 0 ? message : 'the connection failed.';
}

function meetsMinVersion(version: string, floor: string): boolean {
	const current = parseVersion(version);
	const [cMajor, cMinor, cPatch] = current.release;
	const [mMajor, mMinor, mPatch] = parseVersion(floor).release;

	if (cMajor !== mMajor) return cMajor > mMajor;
	if (cMinor !== mMinor) return cMinor > mMinor;
	if (cPatch !== mPatch) return cPatch > mPatch;

	return !current.prerelease;
}

const SEMVER =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parseVersion(version: string): { release: [number, number, number]; prerelease: boolean } {
	const match = SEMVER.exec(version);
	if (!match) throw new Error('malformed version');

	const release = [Number(match[1]), Number(match[2]), Number(match[3])] as [number, number, number];

	for (const component of release) {
		if (!Number.isSafeInteger(component)) throw new Error('malformed version');
	}

	return { release, prerelease: match[4] !== undefined };
}
