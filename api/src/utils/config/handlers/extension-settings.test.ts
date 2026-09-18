import { getExtensionConfigSecretName } from '@cairncms/constants';
import type { ExtensionSettings, SchemaOverview } from '@cairncms/types';
import { promises as fs } from 'fs';
import knex from 'knex';
import { createTracker, MockClient, type Tracker } from 'knex-mock-client';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CairnConfig, ExtensionSettingLeaf, ExtensionSettingsIdentity } from '../../../types/config.js';
import { readConfigDirectory } from '../../read-config-directory.js';
import { validateConfigRecord } from '../../validate-desired-config.js';
import { writeConfigDirectory } from '../../write-config-directory.js';
import { ConfigReadFailedException } from '../../../exceptions/config-read-failed.js';
import type { ApplyContext, PlanContext, ReadContext, ValidationContext } from '../descriptor.js';
import {
	buildExtensionDeclarationSnapshot,
	extensionSettingsDescriptor,
	type ExtensionSettingsKindTypes,
} from './extension-settings.js';

const extensionMock = vi.hoisted(() => ({ complete: true, owners: [] as unknown[] }));

vi.mock('../../../extensions.js', () => ({
	getExtensionManager: () => ({
		isSettingsDiscoveryComplete: () => extensionMock.complete,
		getSettingsOwners: () => extensionMock.owners,
	}),
}));

const serviceMock = vi.hoisted(() => ({ set: vi.fn(), deleteOne: vi.fn(), applyForConfig: vi.fn() }));

vi.mock('../../../services/extension-settings.js', () => ({
	ExtensionSettingsService: vi.fn(() => serviceMock),
}));

const TABLE = 'cairncms_extension_settings';
const WIDGET = '@cairncms/extension-widget';
const METRICS = 'cairncms-extension-metrics';

// Structurally valid but not decryptable: reads validate and fingerprint envelopes without using a key.
function secretEnvelope(ciphertext: string): string {
	return JSON.stringify({
		kind: 'cairncms-secret-envelope',
		v: 1,
		alg: 'aes-256-gcm',
		kid: 'env:default',
		salt: Buffer.alloc(16, 1).toString('base64'),
		iv: Buffer.alloc(12, 2).toString('base64'),
		ct: Buffer.from(ciphertext).toString('base64'),
		tag: Buffer.alloc(16, 3).toString('base64'),
	});
}

const SECRET_ENVELOPE = secretEnvelope('ciphertext');

const { handler, layout } = extensionSettingsDescriptor;

function declaration(entries: Record<string, unknown>): ExtensionSettings {
	return entries as ExtensionSettings;
}

function snapshot(entries: Record<string, ExtensionSettings>) {
	return { discoveryComplete: true as const, eligible: new Map(Object.entries(entries)) };
}

function validationContext(
	extensionDeclarations: ReturnType<typeof snapshot>,
	currentCollections?: ReadonlySet<string>
): ValidationContext {
	return {
		rolesManaged: false,
		declaredRoleKeys: new Set(),
		foldersManaged: false,
		declaredFolderKeys: new Set(),
		extensionDeclarations,
		...(currentCollections !== undefined && { currentCollections }),
		references: 'current-state',
		currentRoleKeys: new Set(),
		currentFolderKeys: new Set(),
	};
}

function readContext(
	database: unknown,
	options: { readMode?: 'full' | 'identity'; scope?: ReadonlySet<string> } = {}
): ReadContext<ExtensionSettingsKindTypes> {
	return {
		database: database as never,
		schema: {} as SchemaOverview,
		readMode: options.readMode ?? 'full',
		...(options.scope !== undefined && { selectedExtensionSubjects: options.scope }),
		dependency: (() => undefined) as never,
	};
}

function codes(failures: { code: string }[]): string[] {
	return failures.map((failure) => failure.code);
}

function messages(failures: { message: string }[]): string {
	return failures.map((failure) => failure.message).join(' ');
}

afterEach(() => {
	extensionMock.complete = true;
	extensionMock.owners = [];
	serviceMock.set.mockReset();
	serviceMock.deleteOne.mockReset();
	serviceMock.applyForConfig.mockReset();
});

describe('buildExtensionDeclarationSnapshot', () => {
	it('fails closed when settings discovery has not completed', async () => {
		extensionMock.complete = false;
		extensionMock.owners = [{ subject: WIDGET, status: 'available', declaration: {} }];

		const result = await buildExtensionDeclarationSnapshot();

		expect(result.discoveryComplete).toBe(false);
		expect(result.eligible.size).toBe(0);
	});

	it('maps only available owners that carry a subject and a declaration', async () => {
		const widgetDeclaration = declaration({ color: { type: 'string', scope: 'global' } });

		extensionMock.owners = [
			{ subject: WIDGET, displaySubject: WIDGET, status: 'available', declaration: widgetDeclaration },
			{ displaySubject: 'gated', status: 'unavailable' },
			{ subject: METRICS, displaySubject: METRICS, status: 'available' },
		];

		const result = await buildExtensionDeclarationSnapshot();

		expect(result.discoveryComplete).toBe(true);
		expect([...result.eligible.keys()]).toEqual([WIDGET]);
		expect(result.eligible.get(WIDGET)).toBe(widgetDeclaration);
	});
});

describe('validateDesired', () => {
	const widget = snapshot({
		[WIDGET]: declaration({
			color: { type: 'string', scope: 'global' },
			retries: { type: 'number', scope: 'global' },
			token: { type: 'string', scope: 'global', secret: { source: 'inline' } },
			runtime_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
			label: { type: 'string', scope: 'collection' },
		}),
	});

	function document(overrides: {
		subject?: string;
		global?: Record<string, ExtensionSettingLeaf>;
		collections?: Record<string, Record<string, ExtensionSettingLeaf>>;
	}) {
		return {
			subject: overrides.subject ?? WIDGET,
			global: overrides.global ?? {},
			collections: overrides.collections ?? {},
		};
	}

	it('accepts declared ordinary values at their declared scope and type', () => {
		const failures = handler.validateDesired(
			[document({ global: { color: 'blue', retries: 3 }, collections: { articles: { label: 'News' } } })],
			[],
			validationContext(widget, new Set(['articles']))
		);

		expect(failures).toEqual([]);
	});

	it('rejects an invalid extension subject name', () => {
		const failures = handler.validateDesired(
			[document({ subject: 'not-an-extension' })],
			[],
			validationContext(widget)
		);

		expect(codes(failures)).toContain('CONFIG_INVALID');
		expect(messages(failures)).toContain('valid extension package name');
	});

	it('reports a duplicate subject as an identity conflict', () => {
		const failures = handler.validateDesired([document({}), document({})], [], validationContext(widget));

		expect(codes(failures)).toContain('CONFIG_IDENTITY_CONFLICT');
	});

	it('rejects a subject that is not installed or eligible on the target', () => {
		const failures = handler.validateDesired([document({ subject: METRICS })], [], validationContext(widget));

		expect(messages(failures)).toContain('not installed or eligible');
	});

	it('validates only structure for a server snapshot, with no eligibility catalogue', () => {
		const context: ValidationContext = {
			rolesManaged: false,
			declaredRoleKeys: new Set(),
			foldersManaged: false,
			declaredFolderKeys: new Set(),
			references: 'server-snapshot',
		};

		expect(handler.validateDesired([document({ subject: METRICS, global: { anything: 'x' } })], [], context)).toEqual(
			[]
		);
	});

	it('rejects an undeclared key', () => {
		const failures = handler.validateDesired(
			[document({ global: { unknown_key: 'x' } })],
			[],
			validationContext(widget)
		);

		expect(messages(failures)).toContain('not declared by the extension');
	});

	it('rejects a key declared at a different scope', () => {
		const failures = handler.validateDesired(
			[document({ global: { label: 'x' } })],
			[],
			validationContext(widget, new Set(['articles']))
		);

		expect(messages(failures)).toContain('scope');
	});

	it('rejects a value whose type does not match the declaration', () => {
		const failures = handler.validateDesired(
			[document({ global: { retries: 'three' } })],
			[],
			validationContext(widget)
		);

		expect(messages(failures)).toContain('must be a number');
	});

	it('rejects an ordinary value written as a runtime-reference expression', () => {
		const reference = `{{${getExtensionConfigSecretName(WIDGET, 'color')}}}`;

		const failures = handler.validateDesired(
			[document({ global: { color: reference } })],
			[],
			validationContext(widget)
		);

		expect(messages(failures)).toContain('must not use a runtime-reference expression');
	});

	it('accepts only the preserve marker for an inline secret', () => {
		expect(
			handler.validateDesired([document({ global: { token: { $secret: 'preserve' } } })], [], validationContext(widget))
		).toEqual([]);

		const failures = handler.validateDesired(
			[document({ global: { token: 'plaintext' } })],
			[],
			validationContext(widget)
		);

		expect(messages(failures)).toContain('only accepts "$secret: preserve"');
	});

	it('requires a config-sourced secret to be its exact runtime reference', () => {
		const reference = `{{${getExtensionConfigSecretName(WIDGET, 'runtime_key')}}}`;

		expect(
			handler.validateDesired([document({ global: { runtime_key: reference } })], [], validationContext(widget))
		).toEqual([]);

		const failures = handler.validateDesired(
			[document({ global: { runtime_key: 'literal' } })],
			[],
			validationContext(widget)
		);

		expect(messages(failures)).toContain('must be its exact runtime reference');
	});

	it('rejects a collection that does not exist in the target schema', () => {
		const failures = handler.validateDesired(
			[document({ collections: { ghost: { label: 'x' } } })],
			[],
			validationContext(widget, new Set(['articles']))
		);

		expect(messages(failures)).toContain('does not exist');
	});
});

describe('readCurrent', () => {
	let db: ReturnType<typeof knex.default>;
	let tracker: Tracker;

	beforeEach(() => {
		db = knex.default({ client: MockClient });
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
	});

	function rowsFor(records: Record<string, unknown>[]): void {
		tracker.on.select(TABLE).response(records);
	}

	it('reads nothing and does not query the table when no subject is eligible', async () => {
		extensionMock.owners = [];

		const result = await handler.readCurrent(readContext(db));

		expect(result.records).toEqual([]);
		expect(tracker.history.select).toHaveLength(0);
	});

	it('fails closed with a read error when settings discovery is incomplete', async () => {
		extensionMock.complete = false;
		extensionMock.owners = [{ subject: WIDGET, status: 'available', declaration: {} }];

		await expect(handler.readCurrent(readContext(db))).rejects.toThrow(ConfigReadFailedException);
		expect(tracker.history.select).toHaveLength(0);
	});

	it('skips rows for uninstalled subjects, undeclared keys, and config-sourced keys', async () => {
		extensionMock.owners = [
			{
				subject: WIDGET,
				status: 'available',
				declaration: declaration({
					color: { type: 'string', scope: 'global' },
					runtime_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
				}),
			},
		];

		rowsFor([
			{ extension: METRICS, scope: 'global', scope_key: '', key: 'color', value: '"red"' },
			{ extension: WIDGET, scope: 'global', scope_key: '', key: 'retired_key', value: '"x"' },
			{ extension: WIDGET, scope: 'global', scope_key: '', key: 'runtime_key', value: '"stored"' },
			{ extension: WIDGET, scope: 'global', scope_key: '', key: 'color', value: '"blue"' },
		]);

		const result = await handler.readCurrent(readContext(db));

		const ordinary = result.records.filter((record) => record.key === 'color');
		expect(ordinary).toEqual([{ subject: WIDGET, scope: 'global', scope_key: '', key: 'color', value: 'blue' }]);
		expect(result.records.some((record) => record.key === 'retired_key')).toBe(false);
	});

	it('emits a stored secret envelope as the preserve marker with a private fingerprint, never its value', async () => {
		extensionMock.owners = [
			{
				subject: WIDGET,
				status: 'available',
				declaration: declaration({ token: { type: 'string', scope: 'global', secret: { source: 'inline' } } }),
			},
		];

		rowsFor([{ extension: WIDGET, scope: 'global', scope_key: '', key: 'token', value: SECRET_ENVELOPE }]);

		const result = await handler.readCurrent(readContext(db));

		expect(result.records).toHaveLength(1);
		expect(result.records[0]).toMatchObject({ key: 'token', value: { $secret: 'preserve' } });
		expect(typeof result.records[0]!.fingerprint).toBe('string');
	});

	it.each([
		['plaintext', '"plaintext"'],
		['a marker-only object', JSON.stringify({ kind: 'cairncms-secret-envelope' })],
	])('fails closed on a secret whose stored value is %s, not a valid envelope', async (_label, value) => {
		extensionMock.owners = [
			{
				subject: WIDGET,
				status: 'available',
				declaration: declaration({ token: { type: 'string', scope: 'global', secret: { source: 'inline' } } }),
			},
		];

		rowsFor([{ extension: WIDGET, scope: 'global', scope_key: '', key: 'token', value }]);

		await expect(handler.readCurrent(readContext(db))).rejects.toThrow('not an encrypted envelope');
	});

	it('retains a document identity for an eligible subject that has no stored rows', async () => {
		extensionMock.owners = [
			{
				subject: WIDGET,
				status: 'available',
				declaration: declaration({ color: { type: 'string', scope: 'global' } }),
			},
			{
				subject: METRICS,
				status: 'available',
				declaration: declaration({ region: { type: 'string', scope: 'global' } }),
			},
		];

		rowsFor([{ extension: WIDGET, scope: 'global', scope_key: '', key: 'color', value: '"blue"' }]);

		const result = await handler.readCurrent(readContext(db));

		expect(result.documentIdentities.map((identity) => identity.subject).sort()).toEqual([WIDGET, METRICS].sort());
	});

	it('scopes to the selected subjects, so an unrelated subject corrupt row does not block the read', async () => {
		extensionMock.owners = [
			{
				subject: WIDGET,
				status: 'available',
				declaration: declaration({ color: { type: 'string', scope: 'global' } }),
			},
			{
				subject: METRICS,
				status: 'available',
				declaration: declaration({ region: { type: 'string', scope: 'global' } }),
			},
		];

		rowsFor([
			{ extension: WIDGET, scope: 'global', scope_key: '', key: 'color', value: '"blue"' },
			{ extension: METRICS, scope: 'global', scope_key: '', key: 'region', value: 'not-json{' },
		]);

		const result = await handler.readCurrent(readContext(db, { scope: new Set([WIDGET]) }));

		expect(result.records).toEqual([{ subject: WIDGET, scope: 'global', scope_key: '', key: 'color', value: 'blue' }]);
		expect(result.documentIdentities.map((identity) => identity.subject)).toEqual([WIDGET]);
	});

	it('emits a config-sourced key as its runtime reference even with no stored row', async () => {
		extensionMock.owners = [
			{
				subject: WIDGET,
				status: 'available',
				declaration: declaration({ runtime_key: { type: 'string', scope: 'global', secret: { source: 'config' } } }),
			},
		];

		rowsFor([]);

		const result = await handler.readCurrent(readContext(db));

		expect(result.records).toEqual([
			{
				subject: WIDGET,
				scope: 'global',
				scope_key: '',
				key: 'runtime_key',
				value: `{{${getExtensionConfigSecretName(WIDGET, 'runtime_key')}}}`,
			},
		]);
	});

	it.each([
		[
			'a scope that disagrees with the declaration',
			{ scope: 'collection', scope_key: 'articles', value: '"blue"' },
			'scope',
		],
		['a value that is not valid JSON', { scope: 'global', scope_key: '', value: 'not-json' }, 'valid JSON'],
		[
			'a value whose type disagrees with the declaration',
			{ scope: 'global', scope_key: '', value: '5' },
			'declared type',
		],
	])('fails closed on %s', async (_label, row, fragment) => {
		extensionMock.owners = [
			{
				subject: WIDGET,
				status: 'available',
				declaration: declaration({ color: { type: 'string', scope: 'global' } }),
			},
		];

		rowsFor([{ extension: WIDGET, key: 'color', ...row }]);

		await expect(handler.readCurrent(readContext(db))).rejects.toThrow(fragment);
	});
});

describe('projectReadState digest', () => {
	let db: ReturnType<typeof knex.default>;
	let tracker: Tracker;

	beforeEach(() => {
		db = knex.default({ client: MockClient });
		tracker = createTracker(db);
	});

	afterEach(() => {
		tracker.reset();
	});

	async function digestOf(owners: unknown[], rows: Record<string, unknown>[]): Promise<string> {
		tracker.reset();
		extensionMock.owners = owners;
		tracker.on.select(TABLE).response(rows);
		const result = await handler.readCurrent(readContext(db));
		return JSON.stringify(handler.projectReadState(result, 'full'));
	}

	const secretOwner = [
		{
			subject: WIDGET,
			status: 'available',
			declaration: declaration({ token: { type: 'string', scope: 'global', secret: { source: 'inline' } } }),
		},
	];

	it('changes when a stored secret envelope rotates, though the planned value does not', async () => {
		const before = await digestOf(secretOwner, [
			{ extension: WIDGET, scope: 'global', scope_key: '', key: 'token', value: SECRET_ENVELOPE },
		]);

		const after = await digestOf(secretOwner, [
			{ extension: WIDGET, scope: 'global', scope_key: '', key: 'token', value: secretEnvelope('rotated') },
		]);

		expect(before).not.toEqual(after);
	});

	it('changes when a key classification changes with no stored row change', async () => {
		const asOrdinary = await digestOf(
			[
				{
					subject: WIDGET,
					status: 'available',
					declaration: declaration({ setting: { type: 'string', scope: 'global' } }),
				},
			],
			[]
		);

		const asSecret = await digestOf(
			[
				{
					subject: WIDGET,
					status: 'available',
					declaration: declaration({ setting: { type: 'string', scope: 'global', secret: { source: 'inline' } } }),
				},
			],
			[]
		);

		expect(asOrdinary).not.toEqual(asSecret);
	});
});

describe('config placeholders', () => {
	const filename = 'cairncms-extension-widget-33d0cc9c.yaml';

	afterEach(() => {
		delete process.env['CAIRNCMS_CONFIG_WIDGET_URL'];
	});

	it('interpolates a {{CAIRNCMS_CONFIG_*}} ordinary leaf from the environment on read', () => {
		process.env['CAIRNCMS_CONFIG_WIDGET_URL'] = 'https://live.example';

		const document = layout.parseDocumentFile(
			{ subject: WIDGET, global: { url: '{{CAIRNCMS_CONFIG_WIDGET_URL}}' } },
			filename
		);

		expect(document.global['url']).toBe('https://live.example');
	});

	it('leaves a {{CAIRNCMS_EXT_*}} runtime reference untouched', () => {
		const reference = `{{${getExtensionConfigSecretName(WIDGET, 'runtime_key')}}}`;

		const document = layout.parseDocumentFile({ subject: WIDGET, global: { runtime_key: reference } }, filename);

		expect(document.global['runtime_key']).toBe(reference);
	});

	it('flags a residual CONFIG placeholder but not a runtime reference', () => {
		const reference = `{{${getExtensionConfigSecretName(WIDGET, 'runtime_key')}}}`;

		const problems = extensionSettingsDescriptor.residualPlaceholders!([
			{ subject: WIDGET, global: { url: '{{CAIRNCMS_CONFIG_WIDGET_URL}}', runtime_key: reference }, collections: {} },
		]);

		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain('url');
	});

	it('restores a committed CONFIG placeholder from the existing file on re-snapshot', () => {
		const restored = extensionSettingsDescriptor.restorePlaceholders!(
			{ subject: WIDGET, global: { url: 'https://resolved.example' }, collections: {} },
			{ subject: WIDGET, global: { url: '{{CAIRNCMS_CONFIG_WIDGET_URL}}' }, collections: {} }
		);

		expect(restored.global['url']).toBe('{{CAIRNCMS_CONFIG_WIDGET_URL}}');
	});

	it('never restores a placeholder over a runtime reference, number, boolean, or secret marker', () => {
		const reference = `{{${getExtensionConfigSecretName(WIDGET, 'runtime_key')}}}`;

		const emitted: Record<string, ExtensionSettingLeaf> = {
			ref: reference,
			num: 3,
			flag: true,
			sec: { $secret: 'preserve' },
		};

		const restored = extensionSettingsDescriptor.restorePlaceholders!(
			{ subject: WIDGET, global: { ...emitted }, collections: {} },
			{
				subject: WIDGET,
				global: {
					ref: '{{CAIRNCMS_CONFIG_X}}',
					num: '{{CAIRNCMS_CONFIG_X}}',
					flag: '{{CAIRNCMS_CONFIG_X}}',
					sec: '{{CAIRNCMS_CONFIG_X}}',
				},
				collections: {},
			}
		);

		expect(restored.global).toEqual(emitted);
	});
});

describe('structural leaf schema', () => {
	it('accepts an empty ordinary string at the catalogue-free boundary', () => {
		expect(
			validateConfigRecord('extension-settings', { subject: WIDGET, global: { note: '' }, collections: {} }, 'snapshot')
		).toEqual([]);
	});

	it('rejects an invalid setting key at the catalogue-free boundary', () => {
		const problems = validateConfigRecord(
			'extension-settings',
			{ subject: WIDGET, global: { 'Bad-Key': 'x' }, collections: {} },
			'snapshot'
		);

		expect(problems.length).toBeGreaterThan(0);
	});
});

describe('postPlan', () => {
	const runtimeReference = `{{${getExtensionConfigSecretName(WIDGET, 'runtime_key')}}}`;

	const declarations = snapshot({
		[WIDGET]: declaration({
			color: { type: 'string', scope: 'global' },
			runtime_key: { type: 'string', scope: 'global', secret: { source: 'config' } },
		}),
	});

	function identity(subject: string, key: string): ExtensionSettingsIdentity {
		return { subject, scope: 'global', scope_key: '', key };
	}

	function planContext(subjects: string[]): PlanContext<ExtensionSettingsKindTypes> {
		return {
			dependency: (() => undefined) as never,
			desiredSubjects: new Set(subjects),
			extensionDeclarations: declarations,
		};
	}

	it('keeps entries for a managed subject and drops entries for an untouched subject', () => {
		const plan = {
			create: [
				{ identity: identity(WIDGET, 'color'), value: 'blue' as ExtensionSettingLeaf },
				{ identity: identity(METRICS, 'color'), value: 'green' as ExtensionSettingLeaf },
			],
			update: [],
			delete: [{ identity: identity(METRICS, 'stale') }],
		};

		const result = handler.postPlan(plan, planContext([WIDGET]));

		expect(result.create).toEqual([{ identity: identity(WIDGET, 'color'), value: 'blue' }]);
		expect(result.delete).toEqual([]);
	});

	it('excludes config-sourced identities from the plan', () => {
		const plan = {
			create: [{ identity: identity(WIDGET, 'runtime_key'), value: runtimeReference as ExtensionSettingLeaf }],
			update: [],
			delete: [],
		};

		expect(handler.postPlan(plan, planContext([WIDGET])).create).toEqual([]);
	});

	it('resolves a preserve marker to a no-op create and update while keeping a delete', () => {
		const plan = {
			create: [{ identity: identity(WIDGET, 'color'), value: { $secret: 'preserve' } as ExtensionSettingLeaf }],
			update: [
				{ identity: identity(WIDGET, 'color'), changes: { value: { before: 'blue', after: { $secret: 'preserve' } } } },
			],
			delete: [{ identity: identity(WIDGET, 'color') }],
		};

		const result = handler.postPlan(plan, planContext([WIDGET]));

		expect(result.create).toEqual([]);
		expect(result.update).toEqual([]);
		expect(result.delete).toEqual([{ identity: identity(WIDGET, 'color') }]);
	});
});

describe('parseDocumentFile', () => {
	const filename = 'cairncms-extension-widget-33d0cc9c.yaml';

	it('returns a typed document whose subject derives its filename', () => {
		const document = layout.parseDocumentFile(
			{ subject: WIDGET, global: { color: 'blue' }, collections: { articles: { label: 'News' } } },
			filename
		);

		expect(document).toEqual({
			subject: WIDGET,
			global: { color: 'blue' },
			collections: { articles: { label: 'News' } },
		});
	});

	it('defaults absent global and collections maps to empty', () => {
		expect(layout.parseDocumentFile({ subject: WIDGET }, filename)).toEqual({
			subject: WIDGET,
			global: {},
			collections: {},
		});
	});

	it('rejects a missing subject', () => {
		expect(() => layout.parseDocumentFile({ global: {} }, filename)).toThrow('subject');
	});

	it('rejects an unknown top-level field, so a misspelled values map cannot read as an empty document', () => {
		expect(() => layout.parseDocumentFile({ subject: WIDGET, globla: { color: 'blue' } }, filename)).toThrow(
			'unknown field'
		);
	});

	it('rejects a non-map collection entry, so it cannot read as a cleared collection', () => {
		expect(() => layout.parseDocumentFile({ subject: WIDGET, collections: { articles: null } }, filename)).toThrow(
			'is not a map'
		);
	});

	it('rejects a non-map global or collections field', () => {
		expect(() => layout.parseDocumentFile({ subject: WIDGET, global: [] }, filename)).toThrow('global');
		expect(() => layout.parseDocumentFile({ subject: WIDGET, collections: 'x' }, filename)).toThrow('collections');
	});

	it('rejects a filename that does not match the subject', () => {
		expect(() => layout.parseDocumentFile({ subject: WIDGET }, 'wrong-name.yaml')).toThrow('filename must be');
	});
});

describe('filename ownership', () => {
	it('derives a deterministic stem from the subject', () => {
		expect(layout.filenameOf({ subject: WIDGET })).toBe('cairncms-extension-widget-33d0cc9c');
		expect(layout.filenameOf({ subject: WIDGET })).toBe(layout.filenameOf({ subject: WIDGET }));
	});

	it('owns a generated stem and disowns an arbitrary one', () => {
		expect(layout.ownsFilenameStem!('cairncms-extension-widget-33d0cc9c')).toBe(true);
		expect(layout.ownsFilenameStem!('cairncms-extension-widget')).toBe(false);
		expect(layout.ownsFilenameStem!('operator-notes')).toBe(false);
	});
});

describe('apply', () => {
	const context = {
		database: {} as never,
		schema: {} as SchemaOverview,
		securityContext: { mode: 'system', reason: 'local config apply', accountability: {} as never },
		mutationOptions: { bypassEmitAction: () => undefined } as never,
		extensionDeclarations: snapshot({
			[WIDGET]: declaration({
				color: { type: 'string', scope: 'global' },
				label: { type: 'string', scope: 'collection' },
			}),
		}),
		dependency: (() => undefined) as never,
	} as ApplyContext<ExtensionSettingsKindTypes>;

	it('writes each create through the config mutation path with its captured declaration', async () => {
		const outcome = await handler.applyCreates(
			[{ identity: { subject: WIDGET, scope: 'global', scope_key: '', key: 'color' }, value: 'blue' }],
			context
		);

		expect(serviceMock.applyForConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: 'create',
				subject: WIDGET,
				scope: 'global',
				scopeKey: '',
				key: 'color',
				value: 'blue',
				declared: { type: 'string', scope: 'global' },
			})
		);

		expect(outcome).toEqual({ op: 'create', count: 1 });
	});

	it('removes each delete through the config mutation path with its captured declaration', async () => {
		const outcome = await handler.applyDeletes(
			[{ identity: { subject: WIDGET, scope: 'collection', scope_key: 'articles', key: 'label' } }],
			context
		);

		expect(serviceMock.applyForConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				operation: 'delete',
				subject: WIDGET,
				scope: 'collection',
				scopeKey: 'articles',
				key: 'label',
			})
		);

		expect(outcome).toEqual({ op: 'delete', count: 1 });
	});
});

describe('config directory round-trip', () => {
	let tmpDir: string;

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cairncms-extension-settings-'));
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	function bySubject(documents: CairnConfig['extension-settings']) {
		return [...documents].sort((a, b) => a.subject.localeCompare(b.subject));
	}

	it('preserves the two-level global and collection maps through a write and read', async () => {
		const documents: CairnConfig['extension-settings'] = [
			{
				subject: WIDGET,
				global: { color: 'blue', retries: 3, enabled: true },
				collections: { articles: { label: 'News' } },
			},
			{ subject: METRICS, global: { region: 'us' }, collections: {} },
		];

		const config: CairnConfig = {
			manifest: { version: 2, resources: ['extension-settings'] },
			roles: [],
			permissions: [],
			folders: [],
			settings: [],
			'extension-settings': documents,
		};

		await writeConfigDirectory(config, tmpDir);
		const read = await readConfigDirectory(tmpDir, { notice: () => undefined });

		expect(bySubject(read['extension-settings'])).toEqual(bySubject(documents));
	});
});
