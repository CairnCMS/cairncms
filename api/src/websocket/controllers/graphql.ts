import type { ConnectionInitMessage } from 'graphql-ws';
import { CloseCode, makeServer, type Context, type Server, type SubscribeMessage } from 'graphql-ws';
import { getOperationAST, GraphQLError, type ExecutionArgs, type ExecutionResult } from 'graphql';
import type { Buffer } from 'node:buffer';
import { GraphQLService } from '../../services/graphql/index.js';
import { parseGraphQLQuery, validateGraphQLDocument } from '../../services/graphql/query-gate.js';
import formatGraphqlErrors from '../../services/graphql/utils/process-error.js';
import { ConnectionParams, type WebSocketMessage } from '../messages.js';
import { SocketController, type SocketClient, type SocketControllerOptions } from './base.js';

const CLOSE_TRY_AGAIN_LATER = 1013;
const CLOSE_REASON_MAX_BYTES = 123;

type GraphQLExtra = { client: SocketClient };

interface ConnectionAdapter {
	onMessage: ((data: string) => Promise<void>) | null;
	closed: ((code?: number, reason?: string) => Promise<void>) | null;
}

function fitCloseReason(reason: string): string {
	return new TextEncoder().encode(reason).length <= CLOSE_REASON_MAX_BYTES ? reason : 'Connection closed';
}

export class GraphQLController extends SocketController {
	private readonly gql: Server<GraphQLExtra>;
	private readonly adapters = new WeakMap<SocketClient, ConnectionAdapter>();
	private readonly inflight = new Set<Promise<unknown>>();

	constructor(options: SocketControllerOptions) {
		super(options);

		this.gql = makeServer<ConnectionInitMessage['payload'], GraphQLExtra>({
			connectionInitWaitTimeout: this.authMode === 'handshake' ? 0 : this.authTimeoutMs,
			onConnect: (ctx) => this.handleConnect(ctx.extra.client, ctx.connectionParams),
			onSubscribe: (ctx, message) => this.handleSubscribe(ctx.extra.client, message),
			onNext: (ctx, _message, args, result) => this.redactNext(ctx.extra.client, args, result as ExecutionResult),
			onError: (ctx, _message, errors) => this.redactErrors(ctx.extra.client, errors),
		});
	}

	protected override acceptedSubprotocol(): string {
		return 'graphql-transport-ws';
	}

	protected override createClient(ws: SocketClient, auth: SocketClient['auth'], ip: string): SocketClient {
		const client = super.createClient(ws, auth, ip);

		const adapter: ConnectionAdapter = { onMessage: null, closed: null };
		this.adapters.set(client, adapter);

		adapter.closed = this.gql.opened(
			{
				protocol: client.protocol,
				send: async (data: string) => {
					if (!this.send(client, data).accepted) throw new Error('WebSocket send refused');
				},
				close: (code: number, reason: string) => this.stop(client, { code, reason: fitCloseReason(reason) }),
				onMessage: (cb) => {
					adapter.onMessage = cb;
				},
			},
			{ client }
		);

		client.once('close', (code: number, reason: Buffer) => {
			const settled = adapter.closed?.(code, reason.toString());
			if (settled !== undefined) this.track(settled);
		});

		return client;
	}

	protected override async routeMessage(client: SocketClient, message: WebSocketMessage): Promise<void> {
		const adapter = this.adapters.get(client);
		if (adapter === undefined || adapter.onMessage === null) return;

		// The library promise stays pending for a subscription's lifetime, so it is started concurrently and
		// tracked for rejection and shutdown rather than awaited, which would block later frames.
		const pending = adapter.onMessage(JSON.stringify(message));
		this.track(pending);
		void pending.catch(() => this.stop(client, { code: CloseCode.InternalServerError }));
	}

	override async terminate(): Promise<void> {
		await super.terminate();
		await Promise.allSettled([...this.inflight]);
	}

	private track(work: Promise<unknown>): void {
		this.inflight.add(work);
		void work.catch(() => undefined).finally(() => this.inflight.delete(work));
	}

	protected override sendAuthSuccess(): { accepted: boolean } {
		return { accepted: true };
	}

	protected override rejectRateLimitedMessage(client: SocketClient): void {
		this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
	}

	protected override rejectMalformedFrame(client: SocketClient): void {
		this.stop(client, { code: CloseCode.BadRequest, reason: 'Bad Request' });
	}

	private async handleConnect(
		client: SocketClient,
		connectionParams: Context<ConnectionInitMessage['payload']>['connectionParams']
	): Promise<boolean> {
		const parsed = ConnectionParams.safeParse(connectionParams ?? {});

		if (!parsed.success) {
			this.stop(client, { code: CloseCode.Forbidden, reason: 'Forbidden' });
			return false;
		}

		const token = parsed.data.access_token;

		if (this.authMode === 'strict') {
			if (token !== undefined) {
				this.stop(client, { code: CloseCode.Forbidden, reason: 'Forbidden' });
				return false;
			}

			return true;
		}

		if (token === undefined) {
			if (this.authMode === 'handshake') {
				this.stop(client, { code: CloseCode.Forbidden, reason: 'Forbidden' });
				return false;
			}

			return true;
		}

		const outcome = await this.authenticateConnection(client, token, undefined);

		if (outcome.status === 'authenticated') return true;
		if (outcome.status === 'ignored') return false;

		if (outcome.status === 'capacity') {
			this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
			return false;
		}

		this.stop(client, { code: CloseCode.Forbidden, reason: 'Forbidden' });
		return false;
	}

	private async handleSubscribe(
		client: SocketClient,
		message: SubscribeMessage
	): Promise<readonly GraphQLError[] | ExecutionArgs> {
		const { query, variables, operationName } = message.payload;

		let document;

		try {
			document = parseGraphQLQuery(query);
		} catch (error) {
			return [error as GraphQLError];
		}

		const service = new GraphQLService({
			schema: await this.getSchema({ database: this.database }),
			accountability: client.auth.accountability,
			scope: 'items',
		});

		const schema = service.getSchema();

		const errors = validateGraphQLDocument(schema, document);
		if (errors.length > 0) return errors;

		const operation = getOperationAST(document, operationName ?? undefined);

		if (operation?.operation !== 'subscription') {
			return [new GraphQLError('Only subscription operations are supported over the WebSocket transport.')];
		}

		return {
			schema,
			document,
			variableValues: variables,
			operationName,
			contextValue: { accountability: client.auth.accountability },
		};
	}

	private redactNext(client: SocketClient, args: ExecutionArgs, result: ExecutionResult): ExecutionResult {
		if (result.errors === undefined || result.errors.length === 0) return result;

		return {
			...result,
			errors: formatGraphqlErrors(
				result.errors,
				args.variableValues,
				client.auth.accountability
			) as unknown as readonly GraphQLError[],
		};
	}

	private redactErrors(client: SocketClient, errors: readonly GraphQLError[]): readonly GraphQLError[] {
		return formatGraphqlErrors(errors, undefined, client.auth.accountability) as unknown as readonly GraphQLError[];
	}
}
