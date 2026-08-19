import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refreshEnv } from '../env.js';
import { getWebSocketConfig, type WebSocketResolution } from './config.js';

const BASE_ENV = { ...process.env };

const enabled = {
	WEBSOCKETS_ENABLED: 'true',
	WEBSOCKETS_REST_ENABLED: 'true',
	WEBSOCKETS_REST_AUTH: 'handshake',
};

function setEnv(overrides: Record<string, string>): void {
	process.env = { ...BASE_ENV, ...overrides };
	refreshEnv();
}

function realtimeErrors(resolution: WebSocketResolution): string[] {
	return resolution.active ? [] : resolution.errors.map((error) => error.envVar);
}

function restErrors(resolution: WebSocketResolution): string[] {
	if (!resolution.active || resolution.rest.active) return [];
	return resolution.rest.errors.map((error) => error.envVar);
}

afterEach(() => {
	process.env = { ...BASE_ENV };
	refreshEnv();
});

describe('getWebSocketConfig', () => {
	it('resolves inactive with no errors when realtime is disabled, even with a malformed size', () => {
		setEnv({ MAX_PAYLOAD_SIZE: 'not-a-size' });
		expect(getWebSocketConfig()).toEqual({ active: false, errors: [] });
	});

	it('resolves inactive with a WEBSOCKETS_ENABLED error when the master switch is not a boolean', () => {
		setEnv({ WEBSOCKETS_ENABLED: 'garbage' });
		const resolution = getWebSocketConfig();
		expect(resolution.active).toBe(false);
		expect(realtimeErrors(resolution)).toEqual(['WEBSOCKETS_ENABLED']);
	});

	it('resolves active with the provisional candidates when enabled', () => {
		setEnv(enabled);

		expect(getWebSocketConfig()).toEqual({
			active: true,
			shared: { maxPayload: 1048576, heartbeatPeriodMs: 30000, userConnLimit: 10, ipConnLimit: 50 },
			rest: { active: true, config: { path: '/websocket', connLimit: 1000, auth: 'handshake', authTimeoutMs: 10000 } },
		});
	});

	describe('shared settings', () => {
		it('rejects a malformed MAX_PAYLOAD_SIZE, deactivating realtime', () => {
			setEnv({ ...enabled, MAX_PAYLOAD_SIZE: 'not-a-size' });
			const resolution = getWebSocketConfig();
			expect(resolution.active).toBe(false);
			expect(realtimeErrors(resolution)).toEqual(['MAX_PAYLOAD_SIZE']);
		});

		it('rejects 1gib rather than misreading it as one byte', () => {
			setEnv({ ...enabled, MAX_PAYLOAD_SIZE: '1gib' });
			expect(realtimeErrors(getWebSocketConfig())).toEqual(['MAX_PAYLOAD_SIZE']);
		});

		it('deactivates all realtime when a shared setting is invalid', () => {
			setEnv({ ...enabled, WEBSOCKETS_HEARTBEAT_PERIOD: '5' });
			const resolution = getWebSocketConfig();
			expect(resolution.active).toBe(false);
			expect(realtimeErrors(resolution)).toEqual(['WEBSOCKETS_HEARTBEAT_PERIOD']);
		});

		it('accepts MAX_PAYLOAD_SIZE at its floor and representation ceiling', () => {
			setEnv({ ...enabled, MAX_PAYLOAD_SIZE: '1' });
			expect(getWebSocketConfig()).toMatchObject({ active: true, shared: { maxPayload: 1 } });

			setEnv({ ...enabled, MAX_PAYLOAD_SIZE: String(Number.MAX_SAFE_INTEGER) });
			expect(getWebSocketConfig()).toMatchObject({ active: true, shared: { maxPayload: Number.MAX_SAFE_INTEGER } });
		});

		it('rejects MAX_PAYLOAD_SIZE below the floor and above the representation ceiling', () => {
			setEnv({ ...enabled, MAX_PAYLOAD_SIZE: '0' });
			expect(realtimeErrors(getWebSocketConfig())).toEqual(['MAX_PAYLOAD_SIZE']);

			setEnv({ ...enabled, MAX_PAYLOAD_SIZE: String(Number.MAX_SAFE_INTEGER + 1) });
			expect(realtimeErrors(getWebSocketConfig())).toEqual(['MAX_PAYLOAD_SIZE']);
		});
	});

	describe('REST scope isolation', () => {
		it('keeps realtime active but deactivates REST when a REST setting is invalid', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH: 'basic' });
			const resolution = getWebSocketConfig();
			expect(resolution.active).toBe(true);
			expect(restErrors(resolution)).toEqual(['WEBSOCKETS_REST_AUTH']);
		});

		it('resolves REST inactive without errors when REST is disabled', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_ENABLED: 'false', WEBSOCKETS_REST_AUTH: 'basic' });
			expect(getWebSocketConfig()).toMatchObject({ active: true, rest: { active: false, errors: [] } });
		});

		it('rejects a non-boolean WEBSOCKETS_REST_ENABLED', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_ENABLED: 'garbage' });
			expect(restErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_REST_ENABLED']);
		});

		it('collects every invalid REST setting at once', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_PATH: 'no-slash', WEBSOCKETS_REST_AUTH: 'basic' });
			expect(restErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_REST_PATH', 'WEBSOCKETS_REST_AUTH']);
		});
	});

	describe('path validation', () => {
		for (const path of ['no-slash', '/websocket?x', '/websocket#x', '/web socket']) {
			it(`rejects ${JSON.stringify(path)}`, () => {
				setEnv({ ...enabled, WEBSOCKETS_REST_PATH: path });
				expect(restErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_REST_PATH']);
			});
		}

		it('accepts a nested path', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_PATH: '/realtime/rest' });
			expect(getWebSocketConfig()).toMatchObject({ rest: { active: true, config: { path: '/realtime/rest' } } });
		});
	});

	describe('connection limits', () => {
		const cases = [
			{
				variable: 'WEBSOCKETS_REST_CONN_LIMIT',
				scope: restErrors,
				accepts: (n: number) => ({ rest: { active: true, config: { connLimit: n } } }),
			},
			{
				variable: 'WEBSOCKETS_USER_CONN_LIMIT',
				scope: realtimeErrors,
				accepts: (n: number) => ({ active: true, shared: { userConnLimit: n } }),
			},
			{
				variable: 'WEBSOCKETS_IP_CONN_LIMIT',
				scope: realtimeErrors,
				accepts: (n: number) => ({ active: true, shared: { ipConnLimit: n } }),
			},
		];

		for (const { variable, scope, accepts } of cases) {
			it(`accepts ${variable} at its boundaries and rejects beyond them`, () => {
				setEnv({ ...enabled, [variable]: '1' });
				expect(getWebSocketConfig()).toMatchObject(accepts(1));

				setEnv({ ...enabled, [variable]: '1000' });
				expect(getWebSocketConfig()).toMatchObject(accepts(1000));

				setEnv({ ...enabled, [variable]: '0' });
				expect(scope(getWebSocketConfig())).toEqual([variable]);

				setEnv({ ...enabled, [variable]: '1001' });
				expect(scope(getWebSocketConfig())).toEqual([variable]);
			});

			it(`rejects a non-integer ${variable}`, () => {
				setEnv({ ...enabled, [variable]: '0x10' });
				expect(scope(getWebSocketConfig())).toEqual([variable]);
			});
		}
	});

	describe('time ranges', () => {
		it('bounds WEBSOCKETS_HEARTBEAT_PERIOD to [15, 120]', () => {
			setEnv({ ...enabled, WEBSOCKETS_HEARTBEAT_PERIOD: '15' });
			expect(getWebSocketConfig()).toMatchObject({ active: true, shared: { heartbeatPeriodMs: 15000 } });

			setEnv({ ...enabled, WEBSOCKETS_HEARTBEAT_PERIOD: '120' });
			expect(getWebSocketConfig()).toMatchObject({ active: true, shared: { heartbeatPeriodMs: 120000 } });

			setEnv({ ...enabled, WEBSOCKETS_HEARTBEAT_PERIOD: '14' });
			expect(realtimeErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_HEARTBEAT_PERIOD']);

			setEnv({ ...enabled, WEBSOCKETS_HEARTBEAT_PERIOD: '121' });
			expect(realtimeErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_HEARTBEAT_PERIOD']);
		});

		it('bounds WEBSOCKETS_REST_AUTH_TIMEOUT to [1, 45] in handshake mode', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH_TIMEOUT: '1' });
			expect(getWebSocketConfig()).toMatchObject({ rest: { active: true, config: { authTimeoutMs: 1000 } } });

			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH_TIMEOUT: '45' });
			expect(getWebSocketConfig()).toMatchObject({ rest: { active: true, config: { authTimeoutMs: 45000 } } });

			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH_TIMEOUT: '0' });
			expect(restErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_REST_AUTH_TIMEOUT']);

			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH_TIMEOUT: '46' });
			expect(restErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_REST_AUTH_TIMEOUT']);
		});
	});

	describe('auth-mode-conditional timeout', () => {
		it('converts heartbeat and handshake timeout seconds to milliseconds', () => {
			setEnv({ ...enabled, WEBSOCKETS_HEARTBEAT_PERIOD: '20', WEBSOCKETS_REST_AUTH_TIMEOUT: '12' });

			expect(getWebSocketConfig()).toMatchObject({
				shared: { heartbeatPeriodMs: 20000 },
				rest: { active: true, config: { authTimeoutMs: 12000 } },
			});
		});

		it('ignores a malformed auth timeout in public and strict modes', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH: 'public', WEBSOCKETS_REST_AUTH_TIMEOUT: 'garbage' });
			expect(getWebSocketConfig()).toMatchObject({ rest: { active: true, config: { auth: 'public' } } });

			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH: 'strict', WEBSOCKETS_REST_AUTH_TIMEOUT: 'garbage' });
			expect(getWebSocketConfig()).toMatchObject({ rest: { active: true, config: { auth: 'strict' } } });
		});

		it('validates the auth timeout in handshake mode', () => {
			setEnv({ ...enabled, WEBSOCKETS_REST_AUTH: 'handshake', WEBSOCKETS_REST_AUTH_TIMEOUT: 'garbage' });
			expect(restErrors(getWebSocketConfig())).toEqual(['WEBSOCKETS_REST_AUTH_TIMEOUT']);
		});
	});

	it('resolves a WEBSOCKETS_*_FILE value into the parsed config, proving the allowlist entry', () => {
		const dir = mkdtempSync(join(tmpdir(), 'cairncms-ws-'));

		try {
			const file = join(dir, 'path');
			writeFileSync(file, '/from-file');
			setEnv({ ...enabled, WEBSOCKETS_REST_PATH_FILE: file });
			expect(getWebSocketConfig()).toMatchObject({ rest: { active: true, config: { path: '/from-file' } } });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
