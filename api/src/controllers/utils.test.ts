import argon2 from 'argon2';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger.js', () => {
	const sink: Record<string, unknown> = {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	};

	sink['child'] = () => sink;

	return { default: sink };
});

vi.mock('../database/index.js', () => ({ default: vi.fn(() => ({})) }));

vi.mock('../utils/generate-hash.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/generate-hash.js')>();
	return { ...actual, generateHash: vi.fn(actual.generateHash) };
});

vi.mock('../utils/verify-hash.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../utils/verify-hash.js')>();
	return { ...actual, verifyHash: vi.fn(actual.verifyHash) };
});

import errorHandler from '../middleware/error-handler.js';
import { generateHash } from '../utils/generate-hash.js';
import { verifyHash } from '../utils/verify-hash.js';
import utilsController from './utils.js';

const anonymous = { user: null, role: null, admin: false, app: false, ip: '127.0.0.1' };
const nonAdmin = { user: 'user-id', role: 'role-id', admin: false, app: true, ip: '127.0.0.1' };
const admin = { user: 'admin-id', role: 'admin-role-id', admin: true, app: true, ip: '127.0.0.1' };

function makeApp(accountability: Record<string, unknown>) {
	const app = express();

	app.use(express.json());

	app.use((req: Record<string, unknown>, _res: unknown, next: () => void) => {
		req['accountability'] = accountability;
		next();
	});

	app.use('/utils', utilsController);
	app.use(errorHandler);

	return app;
}

afterEach(() => {
	vi.clearAllMocks();
});

describe('POST /utils/hash/generate and /utils/hash/verify', () => {
	describe.each([
		['anonymous', anonymous],
		['non-admin', nonAdmin],
	])('%s caller', (_label, accountability) => {
		it('is forbidden from generating a hash and runs no hashing', async () => {
			const response = await request(makeApp(accountability))
				.post('/utils/hash/generate')
				.send({ string: 'correct-string' });

			expect(response.status).toBe(403);
			expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
			expect(generateHash).not.toHaveBeenCalled();
		});

		it('is forbidden from verifying a hash and runs no verification', async () => {
			const hash = await argon2.hash('correct-string');

			const response = await request(makeApp(accountability))
				.post('/utils/hash/verify')
				.send({ string: 'correct-string', hash });

			expect(response.status).toBe(403);
			expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
			expect(verifyHash).not.toHaveBeenCalled();
		});
	});

	it.each(['/utils/hash/generate', '/utils/hash/verify'])(
		'rejects an anonymous request to %s before validating its body',
		async (path) => {
			const response = await request(makeApp(anonymous)).post(path).send({});

			expect(response.status).toBe(403);
			expect(response.body.errors[0].extensions.code).toBe('FORBIDDEN');
		}
	);

	it('generates a hash for an admin', async () => {
		const response = await request(makeApp(admin)).post('/utils/hash/generate').send({ string: 'correct-string' });

		expect(response.status).toBe(200);
		expect(response.body.data).toMatch(/^\$argon2/);
		expect(generateHash).toHaveBeenCalledWith('correct-string');
	});

	it('verifies a hash for an admin', async () => {
		const hash = await argon2.hash('correct-string');
		const app = makeApp(admin);

		const match = await request(app).post('/utils/hash/verify').send({ string: 'correct-string', hash });
		const mismatch = await request(app).post('/utils/hash/verify').send({ string: 'wrong-string', hash });

		expect(match.status).toBe(200);
		expect(match.body.data).toBe(true);
		expect(mismatch.status).toBe(200);
		expect(mismatch.body.data).toBe(false);
		expect(verifyHash).toHaveBeenCalledTimes(2);
	});
});
