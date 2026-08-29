import type { SchemaOverview } from '@cairncms/types';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { getEnv } from '../../env.js';
import { Admission } from '../admission.js';
import { SubscriptionRegistry } from '../subscriptions.js';
import { GraphQLController } from './graphql.js';
import { WebSocketController } from './rest.js';

const SCHEMA = { collections: {}, relations: [] } as unknown as SchemaOverview;
const TEST_SECRET = 'realtime-test-secret';
const originalSecret = getEnv()['SECRET'];

function signUser(user: string): string {
	return jwt.sign({ id: user, role: 'role-1', app_access: true, admin_access: false }, TEST_SECRET, {
		issuer: 'cairncms',
		expiresIn: '1h',
	});
}

interface Harness {
	port: number;
	sockets: WebSocket[];
	teardown: () => Promise<void>;
}

async function createHarness(admission: Admission, authMode: 'public' | 'strict'): Promise<Harness> {
	const subscriptions = new SubscriptionRegistry();

	const shared = {
		authMode,
		authTimeoutMs: 10_000,
		maxPayload: 1_048_576,
		heartbeatPeriodMs: 10_000_000,
		admission,
		isOriginAllowed: () => true,
		consumeIpRateLimit: async () => ({ allowed: true }),
		consumeGlobalRateLimit: async () => ({ allowed: true }),
		app: express(),
		database: {} as Knex,
		getSchema: async () => SCHEMA,
		subscriptions,
	};

	const rest = new WebSocketController({ transport: 'rest', path: '/websocket', ...shared });
	const graphql = new GraphQLController({ transport: 'graphql', path: '/graphql', ...shared });

	const server: Server = createServer();
	server.on('upgrade', rest.handleUpgrade);
	server.on('upgrade', graphql.handleUpgrade);
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const port = (server.address() as AddressInfo).port;

	const sockets: WebSocket[] = [];

	const teardown = async () => {
		for (const socket of sockets) socket.terminate();
		await Promise.all([rest.terminate(), graphql.terminate()]);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return { port, sockets, teardown };
}

type ConnectResult = { kind: 'open'; ws: WebSocket } | { kind: 'reject'; status: number };

function connect(
	harness: Harness,
	transport: 'rest' | 'graphql',
	headers?: Record<string, string>
): Promise<ConnectResult> {
	const path = transport === 'rest' ? '/websocket' : '/graphql';
	const protocols = transport === 'rest' ? [] : ['graphql-transport-ws'];
	const ws = new WebSocket(`ws://127.0.0.1:${harness.port}${path}`, protocols, { headers });
	harness.sockets.push(ws);

	return new Promise((resolve, reject) => {
		let settled = false;

		ws.on('open', () => {
			if (settled) return;
			settled = true;
			resolve({ kind: 'open', ws });
		});

		ws.on('unexpected-response', (_req, res) => {
			if (settled) return;
			settled = true;
			resolve({ kind: 'reject', status: res.statusCode ?? 0 });
		});

		ws.on('error', (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
}

let harness: Harness | null = null;

beforeEach(() => {
	getEnv()['SECRET'] = TEST_SECRET;
});

afterEach(async () => {
	if (harness) await harness.teardown();
	harness = null;
	getEnv()['SECRET'] = originalSecret;
});

describe('cross-transport shared admission', () => {
	it('aggregates the per-IP connection count across REST and GraphQL', async () => {
		const admission = new Admission({ process: 100, ip: 2, user: 100, transports: { rest: 100, graphql: 100 } });
		harness = await createHarness(admission, 'public');

		expect((await connect(harness, 'rest')).kind).toBe('open');
		expect((await connect(harness, 'graphql')).kind).toBe('open');

		expect(await connect(harness, 'rest')).toMatchObject({ kind: 'reject', status: 503 });
	});

	it('aggregates the per-user connection count across REST and GraphQL', async () => {
		const admission = new Admission({ process: 100, ip: 100, user: 1, transports: { rest: 100, graphql: 100 } });
		harness = await createHarness(admission, 'strict');

		const headers = { authorization: `Bearer ${signUser('alice')}` };

		expect((await connect(harness, 'rest', headers)).kind).toBe('open');

		expect(await connect(harness, 'graphql', headers)).toMatchObject({ kind: 'reject', status: 503 });
	});

	it('enforces the GraphQL transport cap independently of REST', async () => {
		const admission = new Admission({ process: 100, ip: 100, user: 100, transports: { rest: 100, graphql: 2 } });
		harness = await createHarness(admission, 'public');

		expect((await connect(harness, 'graphql')).kind).toBe('open');
		expect((await connect(harness, 'graphql')).kind).toBe('open');

		expect(await connect(harness, 'graphql')).toMatchObject({ kind: 'reject', status: 503 });

		expect((await connect(harness, 'rest')).kind).toBe('open');
	});
});
