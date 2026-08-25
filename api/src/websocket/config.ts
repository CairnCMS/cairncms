import { getEnv } from '../env.js';
import { parseCount, parseSize, type ConfigParseError } from '../utils/parse-config.js';

const AUTH_MODES = ['public', 'handshake', 'strict'] as const;

export type AuthMode = (typeof AUTH_MODES)[number];

const MAX_PAYLOAD_SPEC = {
	envVar: 'MAX_PAYLOAD_SIZE',
	defaultValue: 1048576,
	floor: 1,
	ceiling: Number.MAX_SAFE_INTEGER,
};

export const TIMER_MAX_MS = 2_147_483_647;

export const OUTBOUND_QUEUE_BYTES = 1_048_576;
export const OUTBOUND_FRAME_CAP = 1_048_576;
export const PENDING_COMMAND_LIMIT = 10;
export const SUBSCRIPTIONS_PER_CONNECTION = 100;
export const SUBSCRIPTIONS_PER_PROCESS = 10_000;
export const SOURCE_EVENT_QUEUE_COUNT = 1000;
export const SOURCE_EVENT_QUEUE_BYTES = 8_388_608;
export const DELIVERY_CONCURRENCY = 5;

const HEARTBEAT_PERIOD_SPEC = {
	envVar: 'WEBSOCKETS_HEARTBEAT_PERIOD',
	defaultValue: 30,
	floor: 1,
	ceiling: Math.floor(TIMER_MAX_MS / (2 * 1000)),
};

const AUTH_TIMEOUT_CEILING = Math.floor(TIMER_MAX_MS / 1000);

const REST_AUTH_TIMEOUT_SPEC = {
	envVar: 'WEBSOCKETS_REST_AUTH_TIMEOUT',
	defaultValue: 10,
	floor: 1,
	ceiling: AUTH_TIMEOUT_CEILING,
};

const GRAPHQL_AUTH_TIMEOUT_SPEC = {
	envVar: 'WEBSOCKETS_GRAPHQL_AUTH_TIMEOUT',
	defaultValue: 10,
	floor: 1,
	ceiling: AUTH_TIMEOUT_CEILING,
};

const CONN_LIMIT_CEILING = Number.MAX_SAFE_INTEGER;

const USER_CONN_LIMIT_SPEC = {
	envVar: 'WEBSOCKETS_USER_CONN_LIMIT',
	defaultValue: 10,
	floor: 1,
	ceiling: CONN_LIMIT_CEILING,
};

const IP_CONN_LIMIT_SPEC = {
	envVar: 'WEBSOCKETS_IP_CONN_LIMIT',
	defaultValue: 50,
	floor: 1,
	ceiling: CONN_LIMIT_CEILING,
};

const REST_CONN_LIMIT_SPEC = {
	envVar: 'WEBSOCKETS_REST_CONN_LIMIT',
	defaultValue: 1000,
	floor: 1,
	ceiling: CONN_LIMIT_CEILING,
};

const GRAPHQL_CONN_LIMIT_SPEC = {
	envVar: 'WEBSOCKETS_GRAPHQL_CONN_LIMIT',
	defaultValue: 1000,
	floor: 1,
	ceiling: CONN_LIMIT_CEILING,
};

const PROCESS_CONN_LIMIT_SPEC = {
	envVar: 'WEBSOCKETS_PROCESS_CONN_LIMIT',
	defaultValue: 1000,
	floor: 1,
	ceiling: CONN_LIMIT_CEILING,
};

export type WebSocketTransportConfig = {
	path: string;
	connLimit: number;
	auth: AuthMode;
	authTimeoutMs: number;
};

export type WebSocketRestConfig = WebSocketTransportConfig;
export type WebSocketGraphQLConfig = WebSocketTransportConfig;

export type WebSocketSharedConfig = {
	maxPayload: number;
	heartbeatPeriodMs: number;
	userConnLimit: number;
	ipConnLimit: number;
	processConnLimit: number;
};

export type TransportResolution<T> = { active: true; config: T } | { active: false; errors: ConfigParseError[] };

export type WebSocketResolution =
	| { active: false; errors: ConfigParseError[] }
	| {
			active: true;
			shared: WebSocketSharedConfig;
			rest: TransportResolution<WebSocketRestConfig>;
			graphql: TransportResolution<WebSocketGraphQLConfig>;
	  };

type LocalResult<T> = { ok: true; value: T } | { ok: false; error: ConfigParseError };

function invalid(envVar: string, message: string): { ok: false; error: ConfigParseError } {
	return { ok: false, error: { envVar, message: `${envVar} ${message}` } };
}

function parseBoolean(envVar: string, raw: unknown): LocalResult<boolean> {
	if (raw === true || raw === false) return { ok: true, value: raw };
	return invalid(envVar, 'must be true or false');
}

function parseAuthMode(envVar: string, raw: unknown): LocalResult<AuthMode> {
	if (typeof raw === 'string' && AUTH_MODES.includes(raw as AuthMode)) return { ok: true, value: raw as AuthMode };
	return invalid(envVar, `must be one of ${AUTH_MODES.join(', ')}`);
}

function parsePath(envVar: string, raw: unknown): LocalResult<string> {
	const fail = invalid(envVar, 'must be a URL path like "/websocket"');

	if (typeof raw !== 'string' || raw.length === 0) return fail;

	try {
		const url = new URL(raw, 'http://localhost');
		if (url.pathname === raw && url.search === '' && url.hash === '') return { ok: true, value: raw };
	} catch {
		return fail;
	}

	return fail;
}

type CountSpec = { envVar: string; defaultValue: number; floor: number; ceiling: number };

function resolveTransport(
	env: Record<string, any>,
	prefix: 'WEBSOCKETS_REST' | 'WEBSOCKETS_GRAPHQL',
	connLimitSpec: CountSpec,
	authTimeoutSpec: CountSpec
): TransportResolution<WebSocketTransportConfig> {
	const enabled = parseBoolean(`${prefix}_ENABLED`, env[`${prefix}_ENABLED`]);
	if (!enabled.ok) return { active: false, errors: [enabled.error] };
	if (enabled.value === false) return { active: false, errors: [] };

	const errors: ConfigParseError[] = [];

	const path = parsePath(`${prefix}_PATH`, env[`${prefix}_PATH`]);
	if (!path.ok) errors.push(path.error);

	const connLimit = parseCount(env[`${prefix}_CONN_LIMIT`], connLimitSpec);
	if (!connLimit.ok) errors.push(connLimit.error);

	const auth = parseAuthMode(`${prefix}_AUTH`, env[`${prefix}_AUTH`]);
	if (!auth.ok) errors.push(auth.error);

	const authTimeout = parseCount(env[`${prefix}_AUTH_TIMEOUT`], authTimeoutSpec);
	if (!authTimeout.ok) errors.push(authTimeout.error);

	if (errors.length > 0 || !path.ok || !connLimit.ok || !auth.ok || !authTimeout.ok) return { active: false, errors };

	return {
		active: true,
		config: {
			path: path.value,
			connLimit: connLimit.value,
			auth: auth.value,
			authTimeoutMs: authTimeout.value * 1000,
		},
	};
}

function resolveRest(env: Record<string, any>): TransportResolution<WebSocketRestConfig> {
	return resolveTransport(env, 'WEBSOCKETS_REST', REST_CONN_LIMIT_SPEC, REST_AUTH_TIMEOUT_SPEC);
}

function resolveGraphQL(env: Record<string, any>): TransportResolution<WebSocketGraphQLConfig> {
	return resolveTransport(env, 'WEBSOCKETS_GRAPHQL', GRAPHQL_CONN_LIMIT_SPEC, GRAPHQL_AUTH_TIMEOUT_SPEC);
}

function deconflictGraphQLPath(
	rest: TransportResolution<WebSocketRestConfig>,
	graphql: TransportResolution<WebSocketGraphQLConfig>
): TransportResolution<WebSocketGraphQLConfig> {
	if (rest.active && graphql.active && graphql.config.path === rest.config.path) {
		return {
			active: false,
			errors: [
				{
					envVar: 'WEBSOCKETS_GRAPHQL_PATH',
					message: 'WEBSOCKETS_GRAPHQL_PATH must differ from the active WEBSOCKETS_REST_PATH',
				},
			],
		};
	}

	return graphql;
}

export function getWebSocketConfig(): WebSocketResolution {
	const env = getEnv();

	const master = parseBoolean('WEBSOCKETS_ENABLED', env['WEBSOCKETS_ENABLED']);
	if (!master.ok) return { active: false, errors: [master.error] };
	if (master.value === false) return { active: false, errors: [] };

	const errors: ConfigParseError[] = [];

	const maxPayload = parseSize(env['MAX_PAYLOAD_SIZE'], MAX_PAYLOAD_SPEC);
	if (!maxPayload.ok) errors.push(maxPayload.error);

	const heartbeat = parseCount(env['WEBSOCKETS_HEARTBEAT_PERIOD'], HEARTBEAT_PERIOD_SPEC);
	if (!heartbeat.ok) errors.push(heartbeat.error);

	const userConnLimit = parseCount(env['WEBSOCKETS_USER_CONN_LIMIT'], USER_CONN_LIMIT_SPEC);
	if (!userConnLimit.ok) errors.push(userConnLimit.error);

	const ipConnLimit = parseCount(env['WEBSOCKETS_IP_CONN_LIMIT'], IP_CONN_LIMIT_SPEC);
	if (!ipConnLimit.ok) errors.push(ipConnLimit.error);

	const processConnLimit = parseCount(env['WEBSOCKETS_PROCESS_CONN_LIMIT'], PROCESS_CONN_LIMIT_SPEC);
	if (!processConnLimit.ok) errors.push(processConnLimit.error);

	if (
		errors.length > 0 ||
		!maxPayload.ok ||
		!heartbeat.ok ||
		!userConnLimit.ok ||
		!ipConnLimit.ok ||
		!processConnLimit.ok
	) {
		return { active: false, errors };
	}

	const shared: WebSocketSharedConfig = {
		maxPayload: maxPayload.value,
		heartbeatPeriodMs: heartbeat.value * 1000,
		userConnLimit: userConnLimit.value,
		ipConnLimit: ipConnLimit.value,
		processConnLimit: processConnLimit.value,
	};

	const rest = resolveRest(env);
	const graphql = deconflictGraphQLPath(rest, resolveGraphQL(env));

	return { active: true, shared, rest, graphql };
}
