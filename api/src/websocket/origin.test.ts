import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Application } from 'express';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { refreshEnv } from '../env.js';
import { createUpgradeOriginPredicate } from './origin.js';

const BASE_ENV = { ...process.env };

const CONFIG_DIR = mkdtempSync(join(tmpdir(), 'cairncms-origin-'));
const EMPTY_CONFIG = join(CONFIG_DIR, 'empty.env');
writeFileSync(EMPTY_CONFIG, '');

function setEnv(overrides: Record<string, string>): void {
	process.env = { ...BASE_ENV, CONFIG_PATH: EMPTY_CONFIG, ...overrides };
	refreshEnv();
}

afterEach(() => {
	process.env = { ...BASE_ENV };
	refreshEnv();
});

afterAll(() => {
	rmSync(CONFIG_DIR, { recursive: true, force: true });
});

function fakeApp(trusted: boolean): Application {
	return { get: (key: string) => (key === 'trust proxy fn' ? () => trusted : undefined) } as unknown as Application;
}

function makeReq(opts: {
	origins?: string[];
	host?: string;
	encrypted?: boolean;
	remoteAddress?: string;
	xForwardedProto?: string;
}): IncomingMessage {
	const headers: Record<string, unknown> = {};
	if (opts.host !== undefined) headers['host'] = opts.host;
	if (opts.xForwardedProto !== undefined) headers['x-forwarded-proto'] = opts.xForwardedProto;
	if (opts.origins?.length === 1) headers['origin'] = opts.origins[0];

	const headersDistinct: Record<string, unknown> = {};
	if (opts.origins !== undefined) headersDistinct['origin'] = opts.origins;

	return {
		headers,
		headersDistinct,
		socket: { encrypted: opts.encrypted ?? false, remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
	} as unknown as IncomingMessage;
}

describe('createUpgradeOriginPredicate', () => {
	it('throws at init for an absolute-but-unparseable PUBLIC_URL, and builds otherwise', () => {
		setEnv({ PUBLIC_URL: 'https://:::bad' });
		expect(() => createUpgradeOriginPredicate()).toThrow();

		setEnv({ PUBLIC_URL: 'https://app.example' });
		expect(createUpgradeOriginPredicate()).toBeTypeOf('function');

		setEnv({ PUBLIC_URL: '/' });
		expect(createUpgradeOriginPredicate()).toBeTypeOf('function');
	});

	describe('same-origin is always accepted', () => {
		it('accepts same-origin and rejects cross-origin with CORS disabled', () => {
			setEnv({ PUBLIC_URL: 'https://app.example', CORS_ENABLED: 'false' });
			const allowed = createUpgradeOriginPredicate();

			expect(allowed(fakeApp(false), makeReq({ origins: ['https://app.example'] }))).toBe(true);
			expect(allowed(fakeApp(false), makeReq({ origins: ['https://evil.example'] }))).toBe(false);
			expect(allowed(fakeApp(false), makeReq({}))).toBe(true);
		});

		it('accepts same-origin even under enabled CORS whose allowlist omits it', () => {
			setEnv({ PUBLIC_URL: 'https://app.example', CORS_ENABLED: 'true', CORS_ORIGIN: 'https://frontend.example' });
			const allowed = createUpgradeOriginPredicate();

			expect(allowed(fakeApp(false), makeReq({ origins: ['https://app.example'] }))).toBe(true);
		});
	});

	describe('cross-origin follows CORS_ORIGIN', () => {
		it('accepts a listed origin and rejects an unlisted one under enabled CORS', () => {
			setEnv({ PUBLIC_URL: 'https://app.example', CORS_ENABLED: 'true', CORS_ORIGIN: 'https://frontend.example' });
			const allowed = createUpgradeOriginPredicate();

			expect(allowed(fakeApp(false), makeReq({ origins: ['https://frontend.example'] }))).toBe(true);
			expect(allowed(fakeApp(false), makeReq({ origins: ['https://evil.example'] }))).toBe(false);
		});

		it('accepts any cross-origin with the wildcard', () => {
			setEnv({ PUBLIC_URL: 'https://app.example', CORS_ENABLED: 'true', CORS_ORIGIN: '*' });
			const allowed = createUpgradeOriginPredicate();

			expect(allowed(fakeApp(false), makeReq({ origins: ['https://anywhere.example'] }))).toBe(true);
		});

		it('matches the raw origin, not the canonical form, for a CORS string', () => {
			setEnv({
				PUBLIC_URL: 'https://app.example',
				CORS_ENABLED: 'true',
				CORS_ORIGIN: 'http://frontend.example:80',
			});

			const allowed = createUpgradeOriginPredicate();

			expect(allowed(fakeApp(false), makeReq({ origins: ['http://frontend.example:80'] }))).toBe(true);
		});
	});

	describe('total on bad request headers', () => {
		it('rejects malformed, empty, and duplicate Origin headers without throwing', () => {
			setEnv({ PUBLIC_URL: 'https://app.example', CORS_ENABLED: 'false' });
			const allowed = createUpgradeOriginPredicate();

			expect(allowed(fakeApp(false), makeReq({ origins: ['not a url'] }))).toBe(false);
			expect(allowed(fakeApp(false), makeReq({ origins: [''] }))).toBe(false);
			expect(allowed(fakeApp(false), makeReq({ origins: ['ws://app.example'] }))).toBe(false);

			expect(allowed(fakeApp(false), makeReq({ origins: ['https://app.example', 'https://evil.example'] }))).toBe(
				false
			);
		});

		it('returns false, not a throw, when deriving the server origin from a missing or bad Host', () => {
			setEnv({ PUBLIC_URL: '/', CORS_ENABLED: 'false' });
			const allowed = createUpgradeOriginPredicate();

			expect(allowed(fakeApp(false), makeReq({ origins: ['https://app.example'] }))).toBe(false);
			expect(allowed(fakeApp(false), makeReq({ origins: ['https://app.example'], host: 'bad host' }))).toBe(false);
		});
	});

	describe('scheme parity when the server origin is derived from Host', () => {
		it('derives https from a TLS socket', () => {
			setEnv({ PUBLIC_URL: '/', CORS_ENABLED: 'false' });
			const allowed = createUpgradeOriginPredicate();

			expect(
				allowed(fakeApp(false), makeReq({ origins: ['https://app.example'], host: 'app.example', encrypted: true }))
			).toBe(true);
		});

		it('honors a trusted X-Forwarded-Proto and its first comma value', () => {
			setEnv({ PUBLIC_URL: '/', CORS_ENABLED: 'false' });
			const allowed = createUpgradeOriginPredicate();

			expect(
				allowed(
					fakeApp(true),
					makeReq({ origins: ['https://app.example'], host: 'app.example', xForwardedProto: 'https' })
				)
			).toBe(true);

			expect(
				allowed(
					fakeApp(true),
					makeReq({ origins: ['https://app.example'], host: 'app.example', xForwardedProto: 'https, http' })
				)
			).toBe(true);
		});

		it('ignores an untrusted X-Forwarded-Proto', () => {
			setEnv({ PUBLIC_URL: '/', CORS_ENABLED: 'false' });
			const allowed = createUpgradeOriginPredicate();

			expect(
				allowed(
					fakeApp(false),
					makeReq({ origins: ['https://app.example'], host: 'app.example', xForwardedProto: 'https' })
				)
			).toBe(false);
		});
	});

	it('compares canonical origins, treating default ports and host casing as equal', () => {
		setEnv({ PUBLIC_URL: 'https://app.example', CORS_ENABLED: 'false' });
		const allowed = createUpgradeOriginPredicate();

		expect(allowed(fakeApp(false), makeReq({ origins: ['https://app.example:443'] }))).toBe(true);
		expect(allowed(fakeApp(false), makeReq({ origins: ['https://APP.example'] }))).toBe(true);
	});
});
