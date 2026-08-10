import axios, { type AxiosInstance } from 'axios';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDACT_TEXT } from '../../constants.js';
import {
	createConfinedHostBroker,
	originForAllowlistEntry,
	originForRequestUrl,
	type ConfinedHostBrokerDeps,
	type ConfinedLogEntry,
} from './broker.js';
import {
	HTTP_RESPONSE_BYTES,
	ITEMS_REPLY_BYTES,
	SETTINGS_VALUE_BYTES,
	TEMPLATE_OUTPUT_BYTES,
} from './sandbox-limits.js';
import { ConfinedSecretScope } from './secret-scope.js';
import type { ConfinedHostCallContext } from './types.js';

const context: ConfinedHostCallContext = { extensionId: 'ext-1', contributionId: 'contrib-1', operationId: 'op-1' };

const liveSignal = new AbortController().signal;

function makeBroker(overrides: Partial<ConfinedHostBrokerDeps> = {}, scope = new ConfinedSecretScope()) {
	const logged: ConfinedLogEntry[] = [];

	const deps: ConfinedHostBrokerDeps = {
		capabilities: {},
		log: (entry) => logged.push(entry),
		settings: { declared: [], value: () => null, hasSecret: () => false },
		limits: {
			settingsValueBytes: SETTINGS_VALUE_BYTES,
			httpResponseBytes: HTTP_RESPONSE_BYTES,
			itemsReplyBytes: ITEMS_REPLY_BYTES,
			templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
		},
		...overrides,
	};

	return { dispatch: createConfinedHostBroker(deps, scope), logged, scope };
}

describe('createConfinedHostBroker log', () => {
	it('denies every log level without the log capability', async () => {
		const { dispatch, logged } = makeBroker();

		for (const method of ['log.debug', 'log.info', 'log.warn', 'log.error']) {
			const reply = await dispatch({ method, args: { message: 'hello' } }, context, liveSignal);
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		}

		expect(logged).toHaveLength(0);
	});

	it('emits to the sink with the level and context under the capability', async () => {
		const { dispatch, logged } = makeBroker({ capabilities: { log: true } });

		const reply = await dispatch(
			{ method: 'log.warn', args: { message: 'careful', meta: { n: 1 } } },
			context,
			liveSignal
		);

		expect(reply).toEqual({ ok: true, value: null });
		expect(logged).toEqual([{ level: 'warn', message: 'careful', meta: { n: 1 }, context }]);
	});

	it('redacts a declared-secret key and its propagated value before the sink', async () => {
		const { dispatch, logged } = makeBroker({
			capabilities: { log: true },
			settings: {
				declared: [{ key: 'apiKey', isSecret: true }],
				value: () => null,
				hasSecret: () => false,
			},
		});

		await dispatch(
			{
				method: 'log.info',
				args: { message: 'sent', meta: { apiKey: 'sk_live_1234567890', note: 'used sk_live_1234567890 today' } },
			},
			context,
			liveSignal
		);

		const meta = logged[0]?.meta as Record<string, unknown>;
		expect(meta['apiKey']).toBe(REDACT_TEXT);
		expect(meta['note']).not.toContain('sk_live_1234567890');
	});

	it('redacts scope tokens and resolved secrets from log output', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });
		scope.registerResolved('resolved_real_secret_value');

		const { dispatch, logged } = makeBroker({ capabilities: { log: true } }, scope);

		await dispatch(
			{ method: 'log.info', args: { message: `token ${ref} and resolved_real_secret_value` } },
			context,
			liveSignal
		);

		const message = String(logged[0]?.message);
		expect(message).not.toContain(ref);
		expect(message).not.toContain('resolved_real_secret_value');
		expect(message).toContain(REDACT_TEXT);
	});
});

describe('createConfinedHostBroker settings', () => {
	it('rejects a missing or non-string key', async () => {
		const { dispatch } = makeBroker({ capabilities: {} });

		expect(await dispatch({ method: 'settings.get', args: {} }, context, liveSignal)).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' },
		});

		expect(await dispatch({ method: 'settings.get', args: { key: 7 } }, context, liveSignal)).toMatchObject({
			ok: false,
			error: { code: 'invalid_request' },
		});
	});

	it('returns null for an undeclared key even when the source would have a value', async () => {
		const { dispatch } = makeBroker({
			capabilities: {},
			settings: { declared: [], value: () => 'stale', hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'undeclared' } }, context, liveSignal);
		expect(reply).toEqual({ ok: true, value: null });
	});

	it('returns a declared non-secret value', async () => {
		const { dispatch } = makeBroker({
			capabilities: {},
			settings: { declared: [{ key: 'mode', isSecret: false }], value: () => 'fast', hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'mode' } }, context, liveSignal);
		expect(reply).toEqual({ ok: true, value: 'fast' });
	});

	it('mints a fresh per-call reference for a secret setting and never the value', async () => {
		const scope = new ConfinedSecretScope();

		const { dispatch } = makeBroker(
			{
				capabilities: {},
				settings: {
					declared: [{ key: 'apiKey', isSecret: true }],
					value: () => 'sk_live_raw_never_crosses',
					hasSecret: () => true,
				},
			},
			scope
		);

		const first = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);
		const second = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);

		expect(first).toMatchObject({ ok: true, value: { kind: 'secret-reference' } });
		expect(JSON.stringify(first)).not.toContain('sk_live_raw_never_crosses');

		const firstRef = (first as { value: { ref: string } }).value.ref;
		const secondRef = (second as { value: { ref: string } }).value.ref;

		expect(firstRef).not.toBe(secondRef);
		expect(scope.refs()).toContain(firstRef);

		expect(scope.resolve(firstRef)).toEqual({
			kind: 'extension-setting',
			extensionId: 'ext-1',
			contributionId: 'contrib-1',
			key: 'apiKey',
		});
	});

	it('returns null for a secret setting with no backing secret', async () => {
		const { dispatch } = makeBroker({
			capabilities: {},
			settings: { declared: [{ key: 'apiKey', isSecret: true }], value: () => null, hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);
		expect(reply).toEqual({ ok: true, value: null });
	});

	it('refuses an over-cap setting value before it can reach the reply', async () => {
		const { dispatch } = makeBroker({
			capabilities: {},
			settings: {
				declared: [{ key: 'blob', isSecret: false }],
				value: () => 'x'.repeat(SETTINGS_VALUE_BYTES + 1),
				hasSecret: () => false,
			},
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'blob' } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('treats a key with conflicting duplicate declarations as secret, in either order and any case', async () => {
		for (const declared of [
			[
				{ key: 'apiKey', isSecret: false },
				{ key: 'apiKey', isSecret: true },
			],
			[
				{ key: 'apiKey', isSecret: true },
				{ key: 'apiKey', isSecret: false },
			],
			[
				{ key: 'apikey', isSecret: false },
				{ key: 'ApiKey', isSecret: true },
			],
			[
				{ key: 'APIKEY', isSecret: true },
				{ key: 'apiKey', isSecret: false },
			],
		]) {
			const { dispatch } = makeBroker({
				capabilities: {},
				settings: { declared, value: () => 'sk_live_raw_never_crosses', hasSecret: () => true },
			});

			const reply = await dispatch({ method: 'settings.get', args: { key: 'apiKey' } }, context, liveSignal);

			expect(reply).toMatchObject({ ok: true, value: { kind: 'secret-reference' } });
			expect(JSON.stringify(reply)).not.toContain('sk_live_raw_never_crosses');
		}
	});

	it('measures the cap against the serialized value, so escaping inflation cannot pass it', async () => {
		// Raw length is under the cap, but every quote escapes to two characters in
		// JSON, so the serialized form is roughly double and breaches it.
		const quoteHeavy = '"'.repeat(SETTINGS_VALUE_BYTES - 1024);

		const { dispatch } = makeBroker({
			capabilities: {},
			settings: { declared: [{ key: 'blob', isSecret: false }], value: () => quoteHeavy, hasSecret: () => false },
		});

		const reply = await dispatch({ method: 'settings.get', args: { key: 'blob' } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('settles with a timeout when the settings source ignores the abort signal', async () => {
		const controller = new AbortController();

		const { dispatch } = makeBroker({
			capabilities: {},
			settings: {
				declared: [{ key: 'slow', isSecret: false }],
				value: () => new Promise(() => undefined),
				hasSecret: () => false,
			},
		});

		const pending = dispatch({ method: 'settings.get', args: { key: 'slow' } }, context, controller.signal);
		controller.abort();

		expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});

	it('passes the per-call signal to the settings source', async () => {
		const seen: AbortSignal[] = [];

		const { dispatch } = makeBroker({
			capabilities: {},
			settings: {
				declared: [{ key: 'mode', isSecret: false }],
				value: (_key, signal) => {
					seen.push(signal);
					return 'fast';
				},
				hasSecret: () => false,
			},
		});

		await dispatch({ method: 'settings.get', args: { key: 'mode' } }, context, liveSignal);

		expect(seen).toEqual([liveSignal]);
	});
});

describe('createConfinedHostBroker dispatch', () => {
	it('answers an unknown method with unsupported', async () => {
		const { dispatch } = makeBroker({ capabilities: { log: true } });
		const reply = await dispatch({ method: 'files.upload', args: {} }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'unsupported' } });
	});

	it('answers an aborted call with a timeout', async () => {
		const controller = new AbortController();
		controller.abort();

		const { dispatch, logged } = makeBroker({ capabilities: { log: true } });
		const reply = await dispatch({ method: 'log.info', args: { message: 'late' } }, context, controller.signal);

		expect(reply).toMatchObject({ ok: false, error: { code: 'timeout' } });
		expect(logged).toHaveLength(0);
	});
});

describe('origin canonicalization', () => {
	it('extracts the origin from a bare allowlist entry, dropping default ports and case', () => {
		expect(originForAllowlistEntry('https://api.example.com')).toBe('https://api.example.com');
		expect(originForAllowlistEntry('https://api.example.com/')).toBe('https://api.example.com');
		expect(originForAllowlistEntry('https://API.Example.com')).toBe('https://api.example.com');
		expect(originForAllowlistEntry('https://api.example.com:443')).toBe('https://api.example.com');
		expect(originForAllowlistEntry('https://api.example.com:8443')).toBe('https://api.example.com:8443');
		expect(originForAllowlistEntry('http://[::1]:8080')).toBe('http://[::1]:8080');
	});

	it('grants nothing for a non-origin allowlist entry', () => {
		for (const entry of [
			'https://api.example.com/safe',
			'https://api.example.com/?q=1',
			'https://api.example.com/#frag',
			'https://user:pass@api.example.com',
			'https://api.example.com.',
			'ftp://api.example.com',
			'not a url',
		]) {
			expect(originForAllowlistEntry(entry), entry).toBeNull();
		}
	});

	it('canonicalizes a request url origin and rejects out-of-contract urls', () => {
		expect(originForRequestUrl('https://API.Example.com/some/path?q=1')).toBe('https://api.example.com');
		expect(originForRequestUrl('https://api.example.com:443/x')).toBe('https://api.example.com');
		expect(originForRequestUrl('https://allowed.com.evil.com/x')).toBe('https://allowed.com.evil.com');
		expect(originForRequestUrl('https://allowed.com@evil.com/x')).toBeNull();
		expect(originForRequestUrl('https://allowed.com./x')).toBeNull();
		expect(originForRequestUrl('ftp://allowed.com/x')).toBeNull();
		expect(originForRequestUrl('not a url')).toBeNull();
	});
});

describe('createConfinedHostBroker request', () => {
	let server: http.Server;
	let origin: string;
	const authSeen: Array<string | undefined> = [];

	beforeAll(async () => {
		server = http.createServer((request, response) => {
			const url = new URL(request.url ?? '/', 'http://localhost');

			if (url.pathname === '/echo') {
				authSeen.push(request.headers['authorization'] ?? (request.headers['x-api-key'] as string | undefined));

				let body = '';
				request.on('data', (chunk) => (body += chunk));

				request.on('end', () => {
					response.writeHead(200, { 'content-type': 'application/json' });

					const bearer = (request.headers['authorization'] ?? '').replace(/^Bearer /, '');

					response.end(
						JSON.stringify({
							method: request.method,
							headers: request.headers,
							echoedAuth: request.headers['authorization'] ?? null,
							encodedAuth: encodeURIComponent(request.headers['authorization'] ?? ''),
							base64Bearer: Buffer.from(bearer).toString('base64'),
						})
					);
				});

				return;
			}

			if (url.pathname === '/big') {
				const bytes = Number(url.searchParams.get('bytes') ?? 0);
				response.writeHead(200, { 'content-type': 'text/plain' });

				let sent = 0;
				const chunk = 'x'.repeat(16 * 1024);

				const writeMore = () => {
					while (sent < bytes) {
						sent += chunk.length;

						if (!response.write(chunk)) {
							response.once('drain', writeMore);
							return;
						}
					}

					response.end();
				};

				writeMore();
				return;
			}

			if (url.pathname === '/gzip-bomb') {
				const decompressed = Buffer.alloc(Number(url.searchParams.get('bytes') ?? 0), 97);
				const compressed = gzipSync(decompressed);
				response.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
				response.end(compressed);
				return;
			}

			if (url.pathname === '/control-chars') {
				const bytes = Number(url.searchParams.get('bytes') ?? 0);
				response.writeHead(200, { 'content-type': 'text/plain' });
				response.end('\x01'.repeat(bytes));
				return;
			}

			if (url.pathname === '/slow') {
				setTimeout(() => {
					response.writeHead(200, { 'content-type': 'text/plain' });
					response.end('finally');
				}, 2_000);

				return;
			}

			response.writeHead(404);
			response.end();
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
		origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
	});

	afterAll(() => {
		server.close();
	});

	function requestBroker(
		overrides: Partial<ConfinedHostBrokerDeps> = {},
		scope = new ConfinedSecretScope(),
		urls: string[] = ['placeholder']
	) {
		const allowed = urls[0] === 'placeholder' ? [origin] : urls;

		return makeBroker(
			{
				capabilities: { request: { urls: allowed } },
				getAxios: async () => axios.create(),
				resolveSecret: async () => null,
				...overrides,
			},
			scope
		);
	}

	const send = (
		broker: ReturnType<typeof makeBroker>,
		args: Record<string, unknown>,
		signal: AbortSignal = liveSignal
	) => broker.dispatch({ method: 'request.send', args }, context, signal);

	it('denies request.send without the request capability', async () => {
		const { dispatch } = makeBroker({ getAxios: async () => axios.create() });
		const reply = await dispatch({ method: 'request.send', args: { url: `${origin}/echo` } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
	});

	it('sends an allowed GET and shapes the response', async () => {
		const broker = requestBroker();
		const reply = await send(broker, { url: `${origin}/echo` });

		expect(reply).toMatchObject({ ok: true, value: { status: 200 } });

		const value = (reply as { value: { body: { method: string } } }).value;
		expect(value.body.method).toBe('GET');
	});

	it('denies an origin outside the allowlist and never reaches the client', async () => {
		let called = 0;

		const broker = requestBroker({
			getAxios: async () => {
				called += 1;
				return axios.create();
			},
		});

		const reply = await send(broker, { url: 'https://evil.example.com/echo' });

		expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		expect(called).toBe(0);
	});

	it('rejects a url carrying credentials', async () => {
		const broker = requestBroker();
		const userinfo = `${origin}/echo`.replace('http://', 'http://user:pass@');
		const reply = await send(broker, { url: userinfo });
		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('allows only GET when no methods are declared and matches declared methods case-insecretly', async () => {
		const getOnly = requestBroker();

		expect(await send(getOnly, { url: `${origin}/echo`, method: 'POST' })).toMatchObject({
			ok: false,
			error: { code: 'denied' },
		});

		const postOnly = requestBroker({ capabilities: { request: { urls: [origin], methods: ['POST'] } } });
		expect(await send(postOnly, { url: `${origin}/echo`, method: 'post' })).toMatchObject({ ok: true });

		expect(await send(postOnly, { url: `${origin}/echo`, method: 'GET' })).toMatchObject({
			ok: false,
			error: { code: 'denied' },
		});
	});

	it('denies a scope token smuggled into the url, a header, or the body', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });

		let called = 0;

		const broker = requestBroker(
			{
				getAxios: async () => {
					called += 1;
					return axios.create();
				},
			},
			scope
		);

		for (const args of [
			{ url: `${origin}/echo?t=${ref}` },
			{ url: `${origin}/echo`, headers: { 'X-Token': ref } },
			{ url: `${origin}/echo`, body: { nested: `Bearer ${ref}` } },
		]) {
			expect(await send(broker, args)).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		}

		expect(called).toBe(0);
	});

	it('strips forbidden, malformed, and non-string request headers', async () => {
		const broker = requestBroker();

		const reply = await send(broker, {
			url: `${origin}/echo`,
			headers: {
				'X-Ok': 'kept',
				Host: 'evil.example.com',
				Connection: 'close',
				'X-Forwarded-For': 'spoofed',
				'Proxy-Authorization': 'sneak',
				'Bad Name': 'dropped',
				'X-Num': 5,
			},
		});

		expect(reply).toMatchObject({ ok: true });

		const headers = (reply as { value: { body: { headers: Record<string, string> } } }).value.body.headers;
		expect(headers['x-ok']).toBe('kept');
		expect(headers['x-forwarded-for']).toBeUndefined();
		expect(headers['proxy-authorization']).toBeUndefined();
		expect(headers['x-num']).toBeUndefined();
	});

	it('injects a bearer secret parent-side and scrubs every echo of it', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });

		const broker = requestBroker({ resolveSecret: async () => 'sk_live_real_secret_value' }, scope);

		authSeen.length = 0;
		const reply = await send(broker, { url: `${origin}/echo`, auth: { bearer: { kind: 'secret-reference', ref } } });

		expect(reply).toMatchObject({ ok: true });
		expect(authSeen).toEqual(['Bearer sk_live_real_secret_value']);

		const serialized = JSON.stringify(reply);
		expect(serialized).not.toContain('sk_live_real_secret_value');
		expect(serialized).toContain(REDACT_TEXT);
	});

	it('injects a named-header secret for a setting binding owned by this invocation', async () => {
		const scope = new ConfinedSecretScope();

		const ref = scope.mint({
			kind: 'extension-setting',
			extensionId: 'ext-1',
			contributionId: 'contrib-1',
			key: 'apiKey',
		});

		const broker = requestBroker({ resolveSecret: async () => 'sk_live_named_secret_value' }, scope);

		authSeen.length = 0;

		const reply = await send(broker, {
			url: `${origin}/echo`,
			auth: { header: 'X-Api-Key', secret: { kind: 'secret-reference', ref } },
		});

		expect(reply).toMatchObject({ ok: true });
		expect(authSeen).toEqual(['sk_live_named_secret_value']);
		expect(JSON.stringify(reply)).not.toContain('sk_live_named_secret_value');
	});

	it('collapses the body when the resolved secret is a substring of the redaction marker', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });
		const broker = requestBroker({ resolveSecret: async () => 'redact' }, scope);

		authSeen.length = 0;
		const reply = await send(broker, { url: `${origin}/echo`, auth: { bearer: { kind: 'secret-reference', ref } } });

		expect(reply).toMatchObject({ ok: true });
		expect(authSeen).toEqual(['Bearer redact']);

		const value = (reply as { value: { body: unknown } }).value;
		expect(value.body).toBe('');
		expect(JSON.stringify(reply)).not.toContain('redact');
	});

	it('scrubs encoded echoes of the resolved secret', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'apiKey' });
		const secret = 'sk live secret value';
		const broker = requestBroker({ resolveSecret: async () => secret }, scope);

		const reply = await send(broker, { url: `${origin}/echo`, auth: { bearer: { kind: 'secret-reference', ref } } });

		expect(reply).toMatchObject({ ok: true });

		const serialized = JSON.stringify(reply);
		expect(serialized).not.toContain(secret);
		expect(serialized).not.toContain(encodeURIComponent(secret));
		expect(serialized).not.toContain('sk+live+secret+value');
		expect(serialized).not.toContain(Buffer.from(secret).toString('base64'));
		expect(serialized).toContain(REDACT_TEXT);
	});

	it('denies forged, cross-scope, and cross-owner references', async () => {
		const scope = new ConfinedSecretScope();
		const otherScope = new ConfinedSecretScope();

		const crossScope = otherScope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'k' });
		const wrongOperation = scope.mint({ kind: 'flow-operation-option', operationId: 'someone-else', key: 'k' });

		const wrongExtension = scope.mint({
			kind: 'extension-setting',
			extensionId: 'other-ext',
			contributionId: 'contrib-1',
			key: 'k',
		});

		const broker = requestBroker({ resolveSecret: async () => 'never_used_secret_value' }, scope);

		for (const ref of ['forged-token', crossScope, wrongOperation, wrongExtension]) {
			const reply = await send(broker, { url: `${origin}/echo`, auth: { bearer: { kind: 'secret-reference', ref } } });
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		}
	});

	it('denies auth when no resolver is wired or the secret is missing', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'k' });
		const auth = { bearer: { kind: 'secret-reference', ref } };

		const noResolver = makeBroker(
			{ capabilities: { request: { urls: [origin] } }, getAxios: async () => axios.create() },
			scope
		);

		expect(await send(noResolver, { url: `${origin}/echo`, auth })).toMatchObject({
			ok: false,
			error: { code: 'denied' },
		});

		const missing = requestBroker({ resolveSecret: async () => null }, scope);

		expect(await send(missing, { url: `${origin}/echo`, auth })).toMatchObject({
			ok: false,
			error: { code: 'denied' },
		});

		const empty = requestBroker({ resolveSecret: async () => '' }, scope);

		expect(await send(empty, { url: `${origin}/echo`, auth })).toMatchObject({
			ok: false,
			error: { code: 'denied' },
		});
	});

	it('settles with a timeout when secret resolution ignores the abort signal', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'k' });
		const controller = new AbortController();

		const broker = requestBroker({ resolveSecret: () => new Promise(() => undefined) }, scope);

		const pending = send(
			broker,
			{ url: `${origin}/echo`, auth: { bearer: { kind: 'secret-reference', ref } } },
			controller.signal
		);

		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});

	it('settles with a timeout when the client factory ignores the abort signal', async () => {
		const controller = new AbortController();
		const broker = requestBroker({ getAxios: () => new Promise(() => undefined) });

		const pending = send(broker, { url: `${origin}/echo` }, controller.signal);
		controller.abort();

		expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});

	it('settles with a timeout when the client ignores the request abort signal', async () => {
		const controller = new AbortController();
		const client = { request: () => new Promise(() => undefined) } as unknown as AxiosInstance;
		const broker = requestBroker({ getAxios: async () => client });

		const pending = send(broker, { url: `${origin}/echo` }, controller.signal);
		controller.abort();

		expect(await pending).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});

	it('denies malformed auth shapes and unsafe header names', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'k' });
		const broker = requestBroker({ resolveSecret: async () => 'never_used_secret_value' }, scope);
		const reference = { kind: 'secret-reference', ref };

		for (const auth of [
			{ bearer: reference, header: 'X-Two', secret: reference },
			{ bearer: { kind: 'something-else', ref } },
			{ header: '', secret: reference },
			{ header: 'Host', secret: reference },
			{ header: 'X-Forwarded-Host', secret: reference },
			{ header: 'Bad Name', secret: reference },
			{ header: 'X\r\nInjected', secret: reference },
		]) {
			const reply = await send(broker, { url: `${origin}/echo`, auth });
			expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
		}
	});

	it('denies an auth header that collides with a guest header', async () => {
		const scope = new ConfinedSecretScope();
		const ref = scope.mint({ kind: 'flow-operation-option', operationId: 'op-1', key: 'k' });
		const broker = requestBroker({ resolveSecret: async () => 'never_used_secret_value' }, scope);

		const reply = await send(broker, {
			url: `${origin}/echo`,
			headers: { 'x-api-key': 'mine' },
			auth: { header: 'X-Api-Key', secret: { kind: 'secret-reference', ref } },
		});

		expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
	});

	it('aborts an oversized streamed response at the cap', async () => {
		const cap = 64 * 1024;

		const broker = requestBroker({
			limits: {
				settingsValueBytes: SETTINGS_VALUE_BYTES,
				httpResponseBytes: cap,
				itemsReplyBytes: ITEMS_REPLY_BYTES,
				templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
			},
		});

		const reply = await send(broker, { url: `${origin}/big?bytes=${cap * 4}` });

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
		expect(JSON.stringify(reply)).not.toContain('xxxx');
	});

	it('aborts a compression expansion bomb at the decompressed cap', async () => {
		const cap = 64 * 1024;

		const broker = requestBroker({
			limits: {
				settingsValueBytes: SETTINGS_VALUE_BYTES,
				httpResponseBytes: cap,
				itemsReplyBytes: ITEMS_REPLY_BYTES,
				templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
			},
		});

		const reply = await send(broker, { url: `${origin}/gzip-bomb?bytes=${cap * 4}` });

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('refuses a response whose serialized form inflates past the cap', async () => {
		// Control characters arrive as one wire byte each but serialize to six, so
		// the wire fits the cap while the serialized reply value does not.
		const cap = 64 * 1024;

		const broker = requestBroker({
			limits: {
				settingsValueBytes: SETTINGS_VALUE_BYTES,
				httpResponseBytes: cap,
				itemsReplyBytes: ITEMS_REPLY_BYTES,
				templateOutputBytes: TEMPLATE_OUTPUT_BYTES,
			},
		});

		const reply = await send(broker, { url: `${origin}/control-chars?bytes=${32 * 1024}` });

		expect(reply).toMatchObject({ ok: false, error: { code: 'invalid_request' } });
	});

	it('honors a requested timeout below the slow upstream', async () => {
		const broker = requestBroker();
		const reply = await send(broker, { url: `${origin}/slow`, timeoutMs: 200 });
		expect(reply).toMatchObject({ ok: false, error: { code: 'timeout' } });
	});
});

describe('createConfinedHostBroker items', () => {
	it('routes items.readMany and items.readOne through the wired seam', async () => {
		const seen: Array<string | number> = [];

		const { dispatch } = makeBroker({
			capabilities: { items: { accountability: 'full-access' } },
			itemsService: () => ({
				readByQuery: async () => [{ id: 1 }],
				readOne: async (key) => {
					seen.push(key);
					return { id: key };
				},
			}),
		});

		expect(await dispatch({ method: 'items.readMany', args: { collection: 'articles' } }, context, liveSignal)).toEqual(
			{
				ok: true,
				value: [{ id: 1 }],
			}
		);

		expect(
			await dispatch({ method: 'items.readOne', args: { collection: 'articles', key: 7 } }, context, liveSignal)
		).toEqual({ ok: true, value: { id: 7 } });

		expect(seen).toEqual([7]);
	});

	it('routes every write verb through the wired seam', async () => {
		const writes: Array<{ method: string; args: unknown[] }> = [];

		const { dispatch } = makeBroker({
			capabilities: { items: { accountability: 'full-access' } },
			itemsService: () => ({
				readByQuery: async () => [],
				readOne: async () => null,
				createOne: async (payload) => {
					writes.push({ method: 'createOne', args: [payload] });
					return 'pk';
				},
				createMany: async (payloads) => {
					writes.push({ method: 'createMany', args: [payloads] });
					return ['pk'];
				},
				updateOne: async (key, payload) => {
					writes.push({ method: 'updateOne', args: [key, payload] });
					return key;
				},
				updateMany: async (keys, payload) => {
					writes.push({ method: 'updateMany', args: [keys, payload] });
					return keys;
				},
				deleteOne: async (key) => {
					writes.push({ method: 'deleteOne', args: [key] });
					return key;
				},
				deleteMany: async (keys) => {
					writes.push({ method: 'deleteMany', args: [keys] });
					return keys;
				},
			}),
		});

		const calls: Array<[string, Record<string, unknown>]> = [
			['items.createOne', { collection: 'articles', payload: { title: 'x' } }],
			['items.createMany', { collection: 'articles', payloads: [{ title: 'x' }] }],
			['items.updateOne', { collection: 'articles', key: 7, payload: { title: 'y' } }],
			['items.updateMany', { collection: 'articles', keys: [7, 8], payload: { title: 'y' } }],
			['items.deleteOne', { collection: 'articles', key: 7 }],
			['items.deleteMany', { collection: 'articles', keys: [7, 8] }],
		];

		for (const [method, args] of calls) {
			expect(await dispatch({ method, args }, context, liveSignal), method).toMatchObject({ ok: true });
		}

		expect(writes).toEqual([
			{ method: 'createOne', args: [{ title: 'x' }] },
			{ method: 'createMany', args: [[{ title: 'x' }]] },
			{ method: 'updateOne', args: [7, { title: 'y' }] },
			{ method: 'updateMany', args: [[7, 8], { title: 'y' }] },
			{ method: 'deleteOne', args: [7] },
			{ method: 'deleteMany', args: [[7, 8]] },
		]);
	});

	it('refuses an unwired items method through the dispatcher', async () => {
		const { dispatch } = makeBroker({ capabilities: { items: { accountability: 'full-access' } } });
		const reply = await dispatch({ method: 'items.upsertOne', args: { collection: 'articles' } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'unsupported' } });
	});

	it('denies items reads and writes without the capability through the dispatcher', async () => {
		const { dispatch } = makeBroker();

		for (const method of ['items.readMany', 'items.createOne', 'items.deleteMany']) {
			const reply = await dispatch({ method, args: { collection: 'articles' } }, context, liveSignal);
			expect(reply, method).toMatchObject({ ok: false, error: { code: 'denied' } });
		}
	});
});

describe('createConfinedHostBroker template', () => {
	it('routes template.renderLiquid through the dispatcher', async () => {
		const { dispatch } = makeBroker({ capabilities: { template: true } });

		const reply = await dispatch(
			{ method: 'template.renderLiquid', args: { template: 'Hi {{ n }}', data: { n: 1 } } },
			context,
			liveSignal
		);

		expect(reply).toEqual({ ok: true, value: 'Hi 1' });
	});

	it('denies template.renderLiquid without the capability through the dispatcher', async () => {
		const { dispatch } = makeBroker();
		const reply = await dispatch({ method: 'template.renderLiquid', args: { template: 'x' } }, context, liveSignal);
		expect(reply).toMatchObject({ ok: false, error: { code: 'denied' } });
	});
});
