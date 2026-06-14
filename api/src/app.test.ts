import { Router } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import createApp from './app.js';

const handlePressureMock = vi.hoisted(() => vi.fn());

vi.mock('@cairncms/pressure', () => ({
	handlePressure: handlePressureMock,
}));

vi.mock('./database', () => ({
	default: vi.fn(),
	getDatabaseClient: vi.fn().mockReturnValue('postgres'),
	isInstalled: vi.fn(),
	validateDatabaseConnection: vi.fn(),
	validateDatabaseExtensions: vi.fn(),
	validateMigrations: vi.fn(),
}));

vi.mock('./env', async () => {
	const actual = (await vi.importActual('./env')) as { default: Record<string, any> };

	const MOCK_ENV = {
		...actual.default,
		KEY: 'xxxxxxx-xxxxxx-xxxxxxxx-xxxxxxxxxx',
		SECRET: 'abcdef',
		SERVE_APP: true,
		PUBLIC_URL: 'http://localhost:8055/example',
		LOG_STYLE: 'raw',
	};

	return {
		default: MOCK_ENV,
		getEnv: () => MOCK_ENV,
	};
});

const mockGetEndpointRouter = vi.fn().mockReturnValue(Router());
const mockGetEmbeds = vi.fn().mockReturnValue({ head: '', body: '' });

vi.mock('./extensions', () => ({
	getExtensionManager: vi.fn().mockImplementation(() => {
		return {
			initialize: vi.fn(),
			getEndpointRouter: mockGetEndpointRouter,
			getEmbeds: mockGetEmbeds,
		};
	}),
}));

vi.mock('./flows', () => ({
	getFlowManager: vi.fn().mockImplementation(() => {
		return {
			initialize: vi.fn(),
		};
	}),
}));

vi.mock('./middleware/check-ip', () => ({
	checkIP: Router(),
}));

vi.mock('./middleware/schema', () => ({
	default: Router(),
}));

vi.mock('./middleware/get-permissions', () => ({
	default: Router(),
}));

vi.mock('./auth', () => ({
	registerAuthProviders: vi.fn(),
}));

function parseCsp(header: string): Record<string, string[]> {
	const directives: Record<string, string[]> = {};

	for (const part of header.split(';')) {
		const tokens = part.trim().split(/\s+/).filter(Boolean);
		const name = tokens.shift();
		if (name) directives[name] = tokens;
	}

	return directives;
}

describe('createApp', async () => {
	describe('Content Security Policy', () => {
		const DEFAULT_CONNECT_SRC = [
			"'self'",
			'https://a.tile.openstreetmap.org',
			'https://b.tile.openstreetmap.org',
			'https://c.tile.openstreetmap.org',
			'https://fonts.openmaptiles.org',
			'https://api.mapbox.com',
		];

		afterEach(async () => {
			const env = (await import('./env.js')).default as Record<string, unknown>;
			delete env['CONTENT_SECURITY_POLICY_DIRECTIVES__CONNECT_SRC'];
		});

		test('Should set content-security-policy header by default', async () => {
			const app = await createApp();
			const response = await request(app).get('/');

			expect(response.headers).toHaveProperty('content-security-policy');
		});

		test('limits connect-src to first-party and map origins, with no external wildcard', async () => {
			const app = await createApp();
			const response = await request(app).get('/');

			const csp = parseCsp(response.headers['content-security-policy']!);

			expect(csp['connect-src']).toEqual(DEFAULT_CONNECT_SRC);

			for (const wildcard of ['https://*', 'wss://*', 'https:', 'wss:', '*']) {
				expect(csp['connect-src']).not.toContain(wildcard);
			}
		});

		test('locks the security-relevant directive defaults', async () => {
			const app = await createApp();
			const response = await request(app).get('/');

			const csp = parseCsp(response.headers['content-security-policy']!);

			expect(csp['default-src']).toEqual(["'self'"]);
			expect(csp['base-uri']).toEqual(["'self'"]);
			expect(csp['object-src']).toEqual(["'none'"]);
			expect(csp['form-action']).toEqual(["'self'"]);
			expect(csp['script-src-attr']).toEqual(["'none'"]);
		});

		test('lets an operator fully replace connect-src, dropping the default origins they omit', async () => {
			const env = (await import('./env.js')).default as Record<string, unknown>;
			env['CONTENT_SECURITY_POLICY_DIRECTIVES__CONNECT_SRC'] = ["'self'", 'https://api.stripe.com'];

			const app = await createApp();
			const response = await request(app).get('/');

			const csp = parseCsp(response.headers['content-security-policy']!);

			expect(csp['connect-src']).toEqual(["'self'", 'https://api.stripe.com']);

			for (const origin of DEFAULT_CONNECT_SRC) {
				if (origin === "'self'") continue;
				expect(csp['connect-src']).not.toContain(origin);
			}
		});

		test('accepts a single-string connect-src override', async () => {
			const env = (await import('./env.js')).default as Record<string, unknown>;
			env['CONTENT_SECURITY_POLICY_DIRECTIVES__CONNECT_SRC'] = 'https://api.stripe.com';

			const app = await createApp();
			const response = await request(app).get('/');

			const csp = parseCsp(response.headers['content-security-policy']!);

			expect(csp['connect-src']).toEqual(['https://api.stripe.com']);
		});

		test('preserves an operator null override by disabling connect-src', async () => {
			const env = (await import('./env.js')).default as Record<string, unknown>;
			env['CONTENT_SECURITY_POLICY_DIRECTIVES__CONNECT_SRC'] = null;

			const app = await createApp();
			const response = await request(app).get('/');

			const csp = parseCsp(response.headers['content-security-policy']!);

			expect(csp['connect-src']).toBeUndefined();
			expect(csp['default-src']).toEqual(["'self'"]);
		});
	});

	describe('Root Redirect', () => {
		test('Should redirect root path by default', async () => {
			const app = await createApp();
			const response = await request(app).get('/');

			expect(response.status).toEqual(302);
		});
	});

	describe('robots.txt file', () => {
		test('Should respond with default robots.txt content', async () => {
			const app = await createApp();
			const response = await request(app).get('/robots.txt');

			expect(response.text).toEqual('User-agent: *\nDisallow: /');
		});
	});

	describe('Admin App', () => {
		test('Should set <base /> tag href to public url with admin relative path', async () => {
			const app = await createApp();
			const response = await request(app).get('/admin');

			expect(response.text).toEqual(expect.stringContaining(`<base href="/example/admin/" />`));
		});

		test('Should remove <embed-head /> and <embed-body /> tags when there are no custom embeds', async () => {
			mockGetEmbeds.mockReturnValueOnce({ head: '', body: '' });

			const app = await createApp();
			const response = await request(app).get('/admin');

			expect(response.text).not.toEqual(expect.stringContaining(`<embed-head />`));
			expect(response.text).not.toEqual(expect.stringContaining(`<embed-body />`));
		});

		test('Should replace <embed-head /> tag with custom embed head', async () => {
			const mockEmbedHead = '<!-- Test Embed Head -->';
			mockGetEmbeds.mockReturnValueOnce({ head: mockEmbedHead, body: '' });

			const app = await createApp();
			const response = await request(app).get('/admin');

			expect(response.text).toEqual(expect.stringContaining(mockEmbedHead));
		});

		test('Should replace <embed-body /> tag with custom embed body', async () => {
			const mockEmbedBody = '<!-- Test Embed Body -->';
			mockGetEmbeds.mockReturnValueOnce({ head: '', body: mockEmbedBody });

			const app = await createApp();
			const response = await request(app).get('/admin');

			expect(response.text).toEqual(expect.stringContaining(mockEmbedBody));
		});
	});

	describe('Server ping endpoint', () => {
		test('Should respond with pong', async () => {
			const app = await createApp();
			const response = await request(app).get('/server/ping');

			expect(response.text).toEqual('pong');
		});
	});

	describe('Custom Endpoints', () => {
		test('Should not contain route for custom endpoint', async () => {
			const testRoute = '/custom-endpoint-to-test';

			const app = await createApp();
			const response = await request(app).get(testRoute);

			expect(response.body).toEqual({
				errors: [
					{
						extensions: {
							code: 'ROUTE_NOT_FOUND',
						},
						message: `Route ${testRoute} doesn't exist.`,
					},
				],
			});
		});

		test('Should contain route for custom endpoint', async () => {
			const testRoute = '/custom-endpoint-to-test';
			const testResponse = { key: 'value' };
			const mockRouter = Router();

			mockRouter.use(testRoute, (_, res) => {
				res.json(testResponse);
			});

			mockGetEndpointRouter.mockReturnValueOnce(mockRouter);

			const app = await createApp();
			const response = await request(app).get(testRoute);

			expect(response.body).toEqual(testResponse);
		});
	});

	describe('Not Found Handler', () => {
		test('Should return ROUTE_NOT_FOUND error when a route does not exist', async () => {
			const testRoute = '/this-route-does-not-exist';

			const app = await createApp();
			const response = await request(app).get(testRoute);

			expect(response.body).toEqual({
				errors: [
					{
						extensions: {
							code: 'ROUTE_NOT_FOUND',
						},
						message: `Route ${testRoute} doesn't exist.`,
					},
				],
			});
		});
	});

	describe('Pressure limiter wiring', () => {
		beforeEach(() => {
			handlePressureMock.mockReset();

			handlePressureMock.mockImplementation(
				(options: { error?: Error }) => (_req: unknown, _res: unknown, next: (err?: Error) => void) =>
					next(options.error ?? new Error('Pressure limit exceeded'))
			);
		});

		afterEach(async () => {
			const env = (await import('./env.js')).default as Record<string, unknown>;
			env['PRESSURE_LIMITER_ENABLED'] = false;
		});

		test('does not register the pressure middleware when PRESSURE_LIMITER_ENABLED is false', async () => {
			const env = (await import('./env.js')).default as Record<string, unknown>;
			env['PRESSURE_LIMITER_ENABLED'] = false;

			const app = await createApp();
			const response = await request(app).get('/server/ping');

			expect(handlePressureMock).not.toHaveBeenCalled();
			expect(response.statusCode).toBe(200);
			expect(response.text).toBe('pong');
		});

		test('registers the pressure middleware with env-derived options when PRESSURE_LIMITER_ENABLED is true', async () => {
			const env = (await import('./env.js')).default as Record<string, unknown>;
			env['PRESSURE_LIMITER_ENABLED'] = true;

			const app = await createApp();

			expect(handlePressureMock).toHaveBeenCalledOnce();
			const options = handlePressureMock.mock.calls[0]![0] as Record<string, unknown>;

			expect(options).toMatchObject({
				sampleInterval: 250,
				maxEventLoopUtilization: 0.99,
				maxEventLoopDelay: 500,
				maxMemoryRss: false,
				maxMemoryHeapUsed: false,
				retryAfter: false,
			});

			const error = options['error'] as { status?: number; message?: string };
			expect(error.status).toBe(503);
			expect(error.message).toBe('Under pressure');

			const response = await request(app).get('/server/ping');
			expect(response.statusCode).toBe(503);
			expect(response.body.errors?.[0]?.extensions?.code).toBe('SERVICE_UNAVAILABLE');
		});
	});
});
