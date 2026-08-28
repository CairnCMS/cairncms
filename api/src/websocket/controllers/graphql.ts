import type { CompleteMessage, ConnectionInitMessage, ErrorMessage } from 'graphql-ws';
import { CloseCode, makeServer, type Context, type Server, type SubscribeMessage } from 'graphql-ws';
import { getOperationAST, GraphQLError, type ExecutionArgs, type ExecutionResult } from 'graphql';
import type { Buffer } from 'node:buffer';
import { ForbiddenException } from '../../exceptions/index.js';
import { GraphQLService } from '../../services/graphql/index.js';
import { parseGraphQLQuery, validateGraphQLDocument } from '../../services/graphql/query-gate.js';
import {
	Rendezvous,
	resolveSubscriptionTarget,
	type SubscriptionOperation,
} from '../../services/graphql/subscription.js';
import formatGraphqlErrors from '../../services/graphql/utils/process-error.js';
import { ConnectionParams, type WebSocketMessage } from '../messages.js';
import type { Subscription } from '../subscriptions.js';
import { resolveTargetService } from '../target.js';
import { isDeleteFeedEligible, isDeleteFeedQueryAllowed } from '../utils/removal.js';
import { SocketController, type SocketClient, type SocketControllerOptions } from './base.js';
import { OperationSequencer } from './operation-sequencer.js';

const CLOSE_TRY_AGAIN_LATER = 1013;
const CLOSE_REASON_MAX_BYTES = 123;

type GraphQLExtra = { client: SocketClient };

interface ConnectionAdapter {
	onMessage: ((data: string) => Promise<void>) | null;
	closed: ((code?: number, reason?: string) => Promise<void>) | null;
	readonly operations: Map<string, SubscriptionOperation>;
	readonly variables: Map<string, unknown>;
	readonly sequencer: OperationSequencer;
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
			onSubscribe: async (ctx, message) => {
				const result = await this.handleSubscribe(ctx.extra.client, message);

				// A subscribe that resolves to errors after the operation was canceled (a `complete` arriving
				// during the schema lookup) reaches neither onError nor onComplete, so clean its variables here.
				if (Array.isArray(result) && !(message.id in ctx.subscriptions)) {
					this.adapters.get(ctx.extra.client)?.variables.delete(message.id);
				}

				return result;
			},
			onNext: (ctx, _message, args, result) => this.redactNext(ctx.extra.client, args, result as ExecutionResult),
			onError: (ctx, message, errors) => this.redactErrors(ctx.extra.client, message, errors),
			onComplete: (ctx, message) => this.handleComplete(ctx.extra.client, message),
		});
	}

	protected override acceptedSubprotocol(): string {
		return 'graphql-transport-ws';
	}

	protected override createClient(ws: SocketClient, auth: SocketClient['auth'], ip: string): SocketClient {
		const client = super.createClient(ws, auth, ip);

		const adapter: ConnectionAdapter = {
			onMessage: null,
			closed: null,
			operations: new Map(),
			variables: new Map(),
			sequencer: new OperationSequencer(
				(frame) => this.deliverFrame(client, frame),
				(work) => this.track(work)
			),
		};

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
			adapter.sequencer.cancel();
			const settled = adapter.closed?.(code, reason.toString());
			if (settled !== undefined) this.track(settled);
		});

		return client;
	}

	protected override async routeMessage(client: SocketClient, message: WebSocketMessage): Promise<void> {
		const adapter = this.adapters.get(client);
		if (adapter === undefined || adapter.onMessage === null) return;

		const frame = JSON.stringify(message);
		const id = (message as { id?: unknown }).id;

		if ((message.type === 'subscribe' || message.type === 'complete') && typeof id === 'string') {
			await adapter.sequencer.route(id, message.type, frame);
			return;
		}

		this.track(this.deliverFrame(client, frame));
	}

	// Let graphql-ws release the operation without sending a completion frame.
	private retireOperation(client: SocketClient, id: string): void {
		const adapter = this.adapters.get(client);
		if (adapter === undefined || adapter.onMessage === null) return;
		void adapter.sequencer.route(id, 'complete', JSON.stringify({ id, type: 'complete' }));
	}

	private deliverFrame(client: SocketClient, frame: string): Promise<void> {
		const adapter = this.adapters.get(client);
		if (adapter === undefined || adapter.onMessage === null) return Promise.resolve();

		// The library promise stays pending for a subscription's lifetime, so it is tracked for rejection and
		// shutdown rather than awaited by the caller, which would block later frames.
		const pending = adapter.onMessage(frame);
		void pending.catch(() => this.stop(client, { code: CloseCode.InternalServerError }));
		return pending;
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

	protected override stop(
		client: SocketClient,
		options: { code?: number; reason?: string; terminate?: boolean } = {}
	): void {
		// stop() marks the client stopping before the asynchronous close handshake, so cancel queued frames at the
		// stopping boundary rather than waiting for the close event that would otherwise let them reserve mid-teardown.
		this.adapters.get(client)?.sequencer.cancel();
		super.stop(client, options);
	}

	protected override rejectRateLimitedMessage(client: SocketClient): void {
		this.stop(client, { code: CLOSE_TRY_AGAIN_LATER });
	}

	protected override rejectPendingOverflow(client: SocketClient): void {
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
		const adapter = this.adapters.get(client);
		adapter?.variables.set(message.id, variables);

		let document;

		try {
			document = parseGraphQLQuery(query);
		} catch (error) {
			return [error as GraphQLError];
		}

		const rawSchema = await this.getSchema({ database: this.database });

		if (!(await this.refreshBeforeCommand(client, rawSchema)) || client.stopping) {
			return [new GraphQLError('The subscription could not be authorized.')];
		}

		const service = new GraphQLService({
			schema: rawSchema,
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

		const target = resolveSubscriptionTarget(schema, operation, document, variables ?? {});

		if (target.errors !== undefined) {
			return target.errors;
		}

		if (target.collection === '') {
			return [new GraphQLError('Only subscription operations are supported over the WebSocket transport.')];
		}

		// The GraphQL selection set is the response shape, never a row query, so the delete feed's query gate always
		// sees the same empty row query the subscription registers with.
		const rowQuery = {};

		if (target.event === 'delete') {
			const accountability = await client.auth.snapshotAccountability(rawSchema);

			if (
				accountability === null ||
				resolveTargetService(target.collection, { schema: rawSchema, accountability }) === null ||
				!isDeleteFeedQueryAllowed(rowQuery) ||
				!isDeleteFeedEligible(target.collection, accountability, rawSchema)
			) {
				const forbidden = new ForbiddenException();
				return [new GraphQLError(forbidden.message, undefined, undefined, undefined, undefined, forbidden)];
			}
		}

		if (adapter === undefined) {
			return [new GraphQLError('The subscription transport is unavailable.')];
		}

		const channel = new Rendezvous();

		const subscription: Subscription = {
			client,
			collection: target.collection,
			query: rowQuery,
			sink: (event, signal) => channel.push(event, signal),
			...(target.event !== undefined && { event: target.event }),
		};

		const reserved = this.subscriptions.reserve(subscription);

		if (!reserved.ok) {
			channel.close();

			return [
				new GraphQLError(
					reserved.reason === 'limit'
						? 'The subscription limit has been reached.'
						: 'Subscriptions are currently unavailable.'
				),
			];
		}

		const { reservation } = reserved;

		let finalized = false;

		const finalize = (): void => {
			if (finalized) return;
			finalized = true;
			channel.close();
			reservation.remove();
			adapter.operations.delete(message.id);
			adapter.variables.delete(message.id);
		};

		const subscriptionOperation: SubscriptionOperation = {
			client,
			channel,
			reservation,
			loadSchema: () => this.getSchema({ database: this.database }),
			finalize,
			retire: () => this.retireOperation(client, message.id),
		};

		adapter.operations.set(message.id, subscriptionOperation);

		return {
			schema,
			document,
			variableValues: variables,
			operationName,
			contextValue: { accountability: client.auth.accountability, operation: subscriptionOperation },
		};
	}

	private handleComplete(client: SocketClient, message: CompleteMessage): void {
		const adapter = this.adapters.get(client);
		adapter?.operations.get(message.id)?.finalize();
		adapter?.variables.delete(message.id);
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

	private redactErrors(
		client: SocketClient,
		message: ErrorMessage,
		errors: readonly GraphQLError[]
	): readonly GraphQLError[] {
		const adapter = this.adapters.get(client);
		const variables = adapter?.variables.get(message.id);
		adapter?.variables.delete(message.id);

		return formatGraphqlErrors(errors, variables, client.auth.accountability) as unknown as readonly GraphQLError[];
	}
}
