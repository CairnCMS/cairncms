import { describe, expect, it } from 'vitest';
import type { ConfigKind, ConfigManifest } from '../../types/config.js';
import { ConfigInvalidException } from '../../exceptions/config-invalid.js';
import { validateConfigManifest } from '../validate-desired-config.js';
import { schemaProvenanceRefusal } from './schema-provenance.js';

const currentRelease = '1.7.0';
const currentVendor = 'postgres';

function manifest(resources: ConfigKind[], schema?: { release: string; vendor: string }): ConfigManifest {
	return { version: 3, resources, ...(schema !== undefined && { schema }) };
}

function refusal(m: ConfigManifest, forceSchema = false): string | undefined {
	return schemaProvenanceRefusal(m, { forceSchema, currentRelease, currentVendor });
}

describe('schemaProvenanceRefusal', () => {
	it('never gates a run that does not manage schema', () => {
		expect(refusal(manifest(['roles']))).toBeUndefined();
	});

	it('passes a matching release and vendor', () => {
		expect(refusal(manifest(['schema'], { release: currentRelease, vendor: currentVendor }))).toBeUndefined();
	});

	it('refuses a missing provenance and names the override', () => {
		const reason = refusal(manifest(['schema']));
		expect(reason).toContain('records no source CairnCMS version or database vendor');
		expect(reason).toContain('--force-schema');
	});

	it('refuses a release mismatch and names both releases and the override', () => {
		const reason = refusal(manifest(['schema'], { release: '1.6.0', vendor: currentVendor }));
		expect(reason).toContain('captured on CairnCMS 1.6.0');
		expect(reason).toContain(`runs ${currentRelease}`);
		expect(reason).toContain('--force-schema');
	});

	it('refuses a vendor mismatch once the release matches', () => {
		const reason = refusal(manifest(['schema'], { release: currentRelease, vendor: 'mysql' }));
		expect(reason).toContain('captured on the mysql database');
		expect(reason).toContain(`uses ${currentVendor}`);
		expect(reason).toContain('--force-schema');
	});

	it('lets the override pass a mismatch and a missing provenance', () => {
		expect(refusal(manifest(['schema'], { release: '1.6.0', vendor: 'mysql' }), true)).toBeUndefined();
		expect(refusal(manifest(['schema']), true)).toBeUndefined();
	});

	it('leaves a malformed provenance to manifest validation, which the override cannot reach', () => {
		const malformed = { version: 3, resources: ['schema'], schema: { release: 123 } };
		expect(() => validateConfigManifest(malformed, 'test')).toThrow(ConfigInvalidException);
	});
});
