import { pathToRelativeUrl } from '@cairncms/utils/node';
import path from 'path';
import { describe, expect, it } from 'vitest';
import generateConfinedBundleEntrypoint from './generate-confined-bundle-entrypoint.js';

describe('generateConfinedBundleEntrypoint', () => {
	it('default-exports a record keyed by type:name over server entries only', () => {
		const out = generateConfinedBundleEntrypoint([
			{ type: 'interface', name: 'ui', source: 'src/ui.js' },
			{ type: 'endpoint', name: 'ep', source: 'src/ep.js' },
			{ type: 'hook', name: 'hk', source: 'src/hk.js' },
			{ type: 'operation', name: 'op', source: { app: 'src/op-app.js', api: 'src/op-api.js' } },
		] as never);

		expect(out).toContain('export default {');
		expect(out).toContain('"endpoint:ep":e');
		expect(out).toContain('"hook:hk":e');
		expect(out).toContain('"operation:op":e');

		// App entries are excluded; they keep the browser bundle.
		expect(out).not.toContain('interface:ui');
		expect(out).not.toContain('ui.js');

		// An operation entry imports its api half, never its app half.
		expect(out).toContain('op-api.js');
		expect(out).not.toContain('op-app.js');
	});

	it('produces an empty record when no server entries are declared', () => {
		const out = generateConfinedBundleEntrypoint([{ type: 'interface', name: 'ui', source: 'src/ui.js' }] as never);
		expect(out).toBe('export default {};');
	});

	it('encodes a source path as a string literal so it cannot inject a second statement', () => {
		const source = "src/a';import './evil.js';//.js";
		const out = generateConfinedBundleEntrypoint([{ type: 'endpoint', name: 'ep', source }] as never);

		// The whole malicious path is one double-quoted specifier, so the output is the
		// single import plus the export, with nothing injected between them.
		const specifier = JSON.stringify(`./${pathToRelativeUrl(path.resolve(source))}`);
		expect(out).toBe(`import e0 from ${specifier};export default {"endpoint:ep":e0};`);
	});
});
