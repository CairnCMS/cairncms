import express from 'express';
import type { ErrorRequestHandler, Request, RequestHandler } from 'express';
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { getCacheKey } from './get-cache-key.js';
import { isWebhookTriggerRoute } from './is-webhook-trigger-route.js';
import { isVerbatimTarget, parseRequestTarget } from './parse-request-target.js';

const request = (fields: Record<string, unknown>) => fields as unknown as Request;

describe('parseRequestTarget', () => {
	test('returns the parsed result for an ordinary target', () => {
		expect(parseRequestTarget(request({ originalUrl: '/items/books?limit=1' }))?.pathname).toBe('/items/books');
	});

	test('parses a protocol-relative target the router also reads as a path', () => {
		expect(parseRequestTarget(request({ originalUrl: '//[x/items' }))?.pathname).toBe('//[x/items');
	});

	test('returns null for an absolute-form target with an invalid host', () => {
		expect(parseRequestTarget(request({ originalUrl: 'http://[/items/books' }))).toBeNull();
	});

	test('reads a target carrying credentials before an invalid host as the path the router reads', () => {
		expect(parseRequestTarget(request({ originalUrl: '//alice:secret@[x/items' }))?.pathname).toBe(
			'//alice:secret@[x/items'
		);
	});

	test('keeps a backslash instead of rewriting it to a slash', () => {
		expect(parseRequestTarget(request({ originalUrl: '/items\\books' }))?.pathname).toBe('/items\\books');
	});

	test('keeps a userinfo prefix instead of reading it as an authority', () => {
		expect(parseRequestTarget(request({ originalUrl: '//alice:secret@host/items' }))?.pathname).toBe(
			'//alice:secret@host/items'
		);
	});

	test('falls back to the url when there is no original url', () => {
		expect(parseRequestTarget(request({ url: '/items/books' }))?.pathname).toBe('/items/books');
	});

	test('returns null when the request has no target', () => {
		expect(parseRequestTarget(request({}))).toBeNull();
	});
});

describe('isVerbatimTarget', () => {
	test.each(['/items/books?limit=1', '/items\\books', '//alice:secret@host/items'])(
		'is true for %s, which parses unchanged',
		(originalUrl) => {
			expect(isVerbatimTarget(request({ originalUrl }))).toBe(true);
		}
	);

	test.each([
		'/users\\me#frag',
		'//alice:secret@host/users/me#frag',
		'//:@h/items/books#frag',
		'http://localhost/items/books',
		'/items/books#frag',
		'/items/books x',
		'http://[/items/books',
	])('is false for %s, which is rewritten or rejected while parsing', (originalUrl) => {
		expect(isVerbatimTarget(request({ originalUrl }))).toBe(false);
	});

	test('is false when the request has no target', () => {
		expect(isVerbatimTarget(request({}))).toBe(false);
	});
});

describe('agreement with the Express router', () => {
	const uuid = '11111111-1111-1111-1111-111111111111';

	interface Reading {
		originalUrl: string;
		path: string | null;
		verbatim: boolean;
		webhook: boolean;
		keyed: boolean;
		routerPath: string | null;
	}

	const readings = new Map<string, Reading>();
	let server: Server;
	let port: number;

	beforeAll(async () => {
		const app = express();

		app.use((req, _res, next) => {
			let keyed = true;

			try {
				getCacheKey(req);
			} catch {
				keyed = false;
			}

			readings.set(req.originalUrl, {
				originalUrl: req.originalUrl,
				path: parseRequestTarget(req)?.pathname ?? null,
				verbatim: isVerbatimTarget(req),
				webhook: isWebhookTriggerRoute(req),
				keyed,
				routerPath: null,
			});

			next();
		});

		const record: RequestHandler = (req, res) => {
			readings.get(req.originalUrl)!.routerPath = `${req.baseUrl}${req.path}`;
			res.status(200).end();
		};

		const users = express.Router();
		users.get('/me', record);
		users.get('/:pk', record);

		const items = express.Router();
		items.get('/:collection', record);
		items.get('/:collection/:pk', record);

		const flows = express.Router();
		flows.get('/trigger/:pk', record);

		app.use('/users', users);
		app.use('/items', items);
		app.use('/flows', flows);
		app.use((_req, res) => res.status(404).end());

		const handleError: ErrorRequestHandler = (_err, _req, res, _next) => res.status(400).end();
		app.use(handleError);

		server = http.createServer(app);
		await new Promise<void>((resolve) => server.listen(0, resolve));
		port = (server.address() as AddressInfo).port;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	function send(path: string): Promise<number> {
		return new Promise((resolve, reject) => {
			const outgoing = http.request({ host: '127.0.0.1', port, path, agent: false }, (res) => {
				res.resume();
				res.on('end', () => resolve(res.statusCode!));
			});

			outgoing.on('error', reject);
			outgoing.end();
		});
	}

	test.each([
		{ target: '/users/me', status: 200, routerPath: '/users/me', verbatim: true },
		{ target: '/users\\me', status: 404, routerPath: null, verbatim: true },
		{ target: '/users\\me#frag', status: 404, routerPath: null, verbatim: false },
		{ target: '//alice:secret@host/users/me', status: 404, routerPath: null, verbatim: true },
		{ target: '//alice:secret@host/users/me#frag', status: 404, routerPath: null, verbatim: false },
		{ target: '/items/books', status: 200, routerPath: '/items/books', verbatim: true },
		{ target: '/items/books#frag', status: 200, routerPath: '/items/books', verbatim: false },
		{ target: '/items/books?limit=1', status: 200, routerPath: '/items/books', verbatim: true },
		{ target: '//:@h/items/books#frag', status: 200, routerPath: '/items/items/books', verbatim: false },
		{ target: '//:@h/items/books', status: 404, routerPath: null, verbatim: true },
		{ target: '/ITEMS/books', status: 200, routerPath: '/ITEMS/books', verbatim: true },
		{ target: '/items/books/', status: 200, routerPath: '/items/books/', verbatim: true },
		{ target: '/items/%62ooks', status: 200, routerPath: '/items/%62ooks', verbatim: true },
		{ target: '/items/a/../books', status: 404, routerPath: null, verbatim: true },
		{ target: '//evil.example/items/books', status: 404, routerPath: null, verbatim: true },
		{ target: '//[x/items', status: 404, routerPath: null, verbatim: true },
		{ target: '//alice:secret@[x/items', status: 404, routerPath: null, verbatim: true },
		{ target: `/flows/trigger/${uuid}`, status: 200, routerPath: `/flows/trigger/${uuid}`, verbatim: true },
		{ target: `/flows/trigger\\${uuid}`, status: 404, routerPath: null, verbatim: true },
		{ target: `/flows/trigger/${uuid}#x`, status: 200, routerPath: `/flows/trigger/${uuid}`, verbatim: false },
		{ target: `/flows/trigger\\${uuid}#x`, status: 200, routerPath: `/flows/trigger/${uuid}`, verbatim: false },
		{ target: 'http://h/users\\me', status: 200, routerPath: '/users/me', verbatim: false },
		{ target: 'http://h/items/books', status: 200, routerPath: '/items/books', verbatim: false },
	])(
		'$target is read verbatim only when the router reads the same path',
		async ({ target, status, routerPath, verbatim }) => {
			expect(await send(target)).toBe(status);

			const reading = readings.get(target)!;
			expect(reading.originalUrl).toBe(target);
			expect(reading.routerPath).toBe(routerPath);
			expect(reading.verbatim).toBe(verbatim);
			expect(reading.keyed).toBe(verbatim);

			if (verbatim) {
				expect(reading.path).toBe(target.split('?')[0]);
				if (routerPath !== null) expect(reading.path).toBe(routerPath);
			}

			expect(reading.webhook).toBe(routerPath?.startsWith('/flows/trigger/') ?? false);
		}
	);

	test('an unparseable target never reaches application middleware', async () => {
		expect(await send('http://[/items/books')).toBe(404);
		expect(readings.has('http://[/items/books')).toBe(false);
	});
});
