import { describe, expect, it } from 'vitest';
import {
	isHttpTarget,
	parseOperatorRemoteTarget,
	RemoteTargetError,
	resolveEndpoint,
} from './operator-remote-target.js';

describe('parseOperatorRemoteTarget', () => {
	it('accepts an https URL and composes endpoints relative to the base', () => {
		const target = parseOperatorRemoteTarget('https://cms.example.com');

		expect(isHttpTarget(target)).toBe(false);
		expect(resolveEndpoint(target, 'config/apply').href).toBe('https://cms.example.com/config/apply');
	});

	it('accepts an http URL', () => {
		const target = parseOperatorRemoteTarget('http://localhost:8055');

		expect(isHttpTarget(target)).toBe(true);
		expect(resolveEndpoint(target, 'server/info').href).toBe('http://localhost:8055/server/info');
	});

	it('preserves a base path whether or not it has a trailing slash', () => {
		const withSlash = parseOperatorRemoteTarget('https://host/cms/');
		const withoutSlash = parseOperatorRemoteTarget('https://host/cms');

		expect(resolveEndpoint(withSlash, 'config/apply').href).toBe('https://host/cms/config/apply');
		expect(resolveEndpoint(withoutSlash, 'config/apply').href).toBe('https://host/cms/config/apply');
	});

	it('rejects a non-http(s) scheme', () => {
		expect(() => parseOperatorRemoteTarget('ftp://host')).toThrow(RemoteTargetError);
		expect(() => parseOperatorRemoteTarget('file:///etc/passwd')).toThrow(RemoteTargetError);
	});

	it('rejects credentials in the URL', () => {
		expect(() => parseOperatorRemoteTarget('https://user:pass@host')).toThrow(/credentials/i);
	});

	it('rejects a query string', () => {
		expect(() => parseOperatorRemoteTarget('https://host?export=yaml')).toThrow(/query/i);
	});

	it('rejects a fragment', () => {
		expect(() => parseOperatorRemoteTarget('https://host#section')).toThrow(/fragment/i);
	});

	it('rejects a value without a scheme', () => {
		expect(() => parseOperatorRemoteTarget('localhost:8055')).toThrow(RemoteTargetError);
		expect(() => parseOperatorRemoteTarget('/config')).toThrow(RemoteTargetError);
	});
});
