import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	authentication,
	configApply,
	configSnapshot,
	createCairnCMS,
	createCollection,
	deleteCollection,
	readCollections,
	rest,
	type ConfigDocumentV3,
} from '../../src/index.js';
import { ENV_KEYS } from './helpers/constants.js';

const URL = process.env[ENV_KEYS.url]!;
const EMAIL = process.env[ENV_KEYS.adminEmail]!;
const PASSWORD = process.env[ENV_KEYS.adminPassword]!;

const PROBE = 'sdk_test_config_probe';

const V1_KEYS = ['manifest', 'permissions', 'roles'];
const V2_KEYS = [...V1_KEYS, 'extension-settings', 'folders', 'settings', 'translations'];
const V3_KEYS = [...V2_KEYS, 'schema'];

type RequestRejection = { errors: Array<{ message: string; extensions: Record<string, unknown> }> };

function adminClient() {
	return createCairnCMS(URL).with(authentication('json')).with(rest());
}

let admin: ReturnType<typeof adminClient>;
let schemaWithoutProbe: ConfigDocumentV3;
let schemaWithProbe: ConfigDocumentV3;

async function probeExists(): Promise<boolean> {
	const collections = await admin.request(readCollections());
	return collections.some((collection) => collection['collection'] === PROBE);
}

async function setProbe(present: boolean): Promise<void> {
	const exists = await probeExists();

	if (present && !exists) await admin.request(createCollection({ collection: PROBE, schema: {}, meta: {} }));
	if (!present && exists) await admin.request(deleteCollection(PROBE));
}

const probeCreate = expect.objectContaining({
	kind: 'collections',
	operation: 'create',
	identity: { collection: PROBE },
});

beforeAll(async () => {
	admin = adminClient();
	await admin.login(EMAIL, PASSWORD);

	await setProbe(false);
	schemaWithoutProbe = await admin.request(configSnapshot({ resources: ['schema'] }));
	await setProbe(true);
	schemaWithProbe = await admin.request(configSnapshot({ resources: ['schema'] }));
	await setProbe(false);
});

afterAll(async () => {
	await setProbe(false);
});

describe('configSnapshot', () => {
	it.each([
		[1, V1_KEYS],
		[2, V2_KEYS],
		[3, V3_KEYS],
	] as const)('returns exactly the version %s arrays', async (manifestVersion, keys) => {
		const document = await admin.request(configSnapshot({ manifestVersion }));

		expect(document.manifest.version).toBe(manifestVersion);
		expect(Object.keys(document).sort()).toEqual([...keys].sort());
	});

	it('captures version 3 by default and manages no kinds for an empty resources list', async () => {
		const latest = await admin.request(configSnapshot());
		const none = await admin.request(configSnapshot({ resources: [] }));

		expect(latest.manifest.version).toBe(3);
		expect(Object.keys(latest).sort()).toEqual([...V3_KEYS].sort());
		expect(none.manifest.resources).toEqual([]);
	});
});

describe('configApply', () => {
	it('previews a schema change in a dry run without applying it', async () => {
		await setProbe(false);

		const plan = await admin.request(configApply(schemaWithProbe, { dryRun: true }));

		expect(plan).toMatchObject({ planVersion: 3, manifestVersion: 3 });
		expect(plan.changes).toContainEqual(probeCreate);
		expect(await probeExists()).toBe(false);
	});

	it('reports a schema-only apply through meta while data is null, then a no-op on repeat', async () => {
		await setProbe(false);

		const applied = await admin.request(configApply(schemaWithProbe));

		expect(applied.data).toBeNull();
		expect(applied.meta.result).toBe('applied');
		expect(applied.meta.steps).toEqual({ folders: 'skipped', schema: 'committed', configuration: 'skipped' });
		expect(applied.meta.plan.changes).toContainEqual(probeCreate);
		expect(await probeExists()).toBe(true);

		const repeated = await admin.request(configApply(schemaWithProbe));

		expect(repeated.data).toBeNull();
		expect(repeated.meta.result).toBe('no_changes');
		expect(repeated.meta.steps).toEqual({ folders: 'skipped', schema: 'skipped', configuration: 'skipped' });
	});

	it('refuses a deletion without destructive and applies it with destructive', async () => {
		await setProbe(true);

		const rejection = await admin.request(configApply(schemaWithoutProbe)).then(
			() => {
				throw new Error('Expected the apply to be refused');
			},
			(error: RequestRejection) => error
		);

		expect(rejection.errors[0]!.extensions['code']).toBe('DESTRUCTIVE_CHANGES_REQUIRED');
		expect(await probeExists()).toBe(true);

		const applied = await admin.request(configApply(schemaWithoutProbe, { destructive: true }));

		expect(applied.meta.result).toBe('applied');
		expect(applied.meta.steps.schema).toBe('committed');
		expect(await probeExists()).toBe(false);
	});

	it('returns an empty result object for a configuration-only no-op', async () => {
		const roles = await admin.request(configSnapshot({ resources: ['roles'] }));

		const result = await admin.request(configApply(roles));

		expect(result.data).not.toBeNull();
		expect(result.data!['roles']).toEqual({ created: [], updated: [], deleted: [] });
		expect(result.meta.result).toBe('no_changes');
		expect(result.meta.steps).toEqual({ folders: 'not_run', schema: 'not_run', configuration: 'skipped' });
	});
});
