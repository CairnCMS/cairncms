import { createRedisTest } from '../../fixtures/redis';
import { capturePrerequisite, requirePrerequisite, type Prerequisite } from '../../fixtures/prerequisite';
import { CreateRole, CreateUser, USER, ROLE } from '../../common/functions';
import { seedDBStructure } from './realtime.seed';

export type RealtimeNodes = { main: string; peer: string; gate: string; foreignUserId: string };

export const realtimeTest = createRedisTest('redis6', {
	absoluteOrigin: true,
	env: {
		WEBSOCKETS_ENABLED: 'true',
		WEBSOCKETS_REST_ENABLED: 'true',
		WEBSOCKETS_GRAPHQL_ENABLED: 'true',
		WEBSOCKETS_REST_AUTH: 'handshake',
		WEBSOCKETS_GRAPHQL_AUTH: 'handshake',
		WEBSOCKETS_REST_PATH: '/websocket',
		WEBSOCKETS_GRAPHQL_PATH: '/graphql',
	},
}).extend<{ nodesState: Prerequisite<RealtimeNodes>; nodes: RealtimeNodes }>({
	nodesState: [
		async ({ apiState, redisState, teardownFailures }, use) => {
			if (!apiState.ok) return use(apiState);
			if (!redisState.ok) return use(redisState);
			const api = apiState.value;

			await capturePrerequisite<RealtimeNodes>(
				async (ready) => {
					const role = await CreateRole(api, {
						name: ROLE.ADMIN.NAME,
						appAccessEnabled: true,
						adminAccessEnabled: true,
					});

					await CreateUser(api, {
						token: USER.ADMIN.TOKEN,
						email: USER.ADMIN.EMAIL,
						password: USER.ADMIN.PASSWORD,
						role: role.id,
					});

					await seedDBStructure(api);
					const foreign = await api.database('directus_users').where({ email: 'bootstrap@example.com' }).first('id');
					if (!foreign?.id) throw new Error('Missing independent foreign owner fixture');

					const peer = await api.start(
						{ WEBSOCKETS_REST_AUTH: 'strict', WEBSOCKETS_GRAPHQL_AUTH: 'strict' },
						{ absoluteOrigin: true }
					);

					const gate = await api.start(
						{
							MESSENGER_NAMESPACE: redisState.value.namespace + '-gate',
							GRAPHQL_INTROSPECTION: 'false',
							GRAPHQL_QUERY_TOKEN_LIMIT: '10',
						},
						{ absoluteOrigin: true }
					);

					await ready({ main: api.url, peer: peer.url, gate: gate.url, foreignUserId: foreign.id });
				},
				use,
				teardownFailures
			);
		},
		{ scope: 'file' },
	],
	nodes: async ({ api, redis, nodesState, task, skip }, use) => {
		void api;
		void redis;
		await use(requirePrerequisite(nodesState, 'realtime schemas, identities and companion APIs', { task, skip }));
	},
});
