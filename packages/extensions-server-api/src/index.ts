/**
 * Portable protocol types and identity helpers for CairnCMS server extensions.
 * The host runtime supplies the host-API implementations and enforces
 * permissions, network policy, redaction, and accountability. Author code sees
 * only brokered method calls and serializable payloads, never raw host objects.
 */

/** A subset of a caller's identity, carried explicitly into every host call. */
export type ExtensionAccountability = {
	user: string | null;
	role: string | null;
	admin: boolean;
};

export type ExtensionActivation = {
	type: 'flow-operation' | 'json-endpoint';
};

/** Coarse, stable denial and failure categories, so author code can branch without depending on host internals. */
export type ExtensionHostErrorCode =
	| 'denied'
	| 'not_found'
	| 'invalid_request'
	| 'unsupported'
	| 'timeout'
	| 'rate_limited'
	| 'internal';

/** A serializable, redaction-safe error carried across the host boundary. */
export type ExtensionHostError = {
	code: ExtensionHostErrorCode;
	message: string;
	details?: Record<string, unknown>;
};

/**
 * The outcome of a privileged host call. Denials and failures travel as
 * `{ ok: false }` data, not thrown exceptions, so they cross the IPC boundary.
 * For `request`, this is host-level denial or transport failure, not the
 * application HTTP status, which is in the response.
 */
export type ExtensionResult<T> = { ok: true; value: T } | { ok: false; error: ExtensionHostError };

/** Brokered structured logger. The host applies redaction before any sink. */
export type ExtensionLogger = {
	debug(message: string, meta?: Record<string, unknown>): Promise<void> | void;
	info(message: string, meta?: Record<string, unknown>): Promise<void> | void;
	warn(message: string, meta?: Record<string, unknown>): Promise<void> | void;
	error(message: string, meta?: Record<string, unknown>): Promise<void> | void;
};

/**
 * Declarative auth for a brokered request. The handle is the opaque reference
 * for a sensitive option or setting. The host resolves it and sets the header,
 * the extension never reads the raw value, and a reference is accepted nowhere
 * else in the request.
 */
export type ExtensionRequestAuth =
	| { bearer: ExtensionSecretReference }
	| { header: string; secret: ExtensionSecretReference };

/** A brokered outbound request. The host owns redirects, timeouts, and policy. */
export type ExtensionRequest = {
	url: string;
	method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	headers?: Record<string, string>;
	body?: unknown;
	timeoutMs?: number;
	auth?: ExtensionRequestAuth;
};

export type ExtensionResponse<T = unknown> = {
	status: number;
	headers: Record<string, string>;
	body: T;
};

export type ExtensionRequestClient = {
	send<T = unknown>(request: ExtensionRequest): Promise<ExtensionResult<ExtensionResponse<T>>>;
};

export type ExtensionQuery = {
	fields?: string[];
	filter?: Record<string, unknown>;
	sort?: string[];
	limit?: number;
	offset?: number;
	page?: number;
	search?: string;
};

export type ExtensionItemsClient = {
	read<T = unknown>(collection: string, query?: ExtensionQuery): Promise<ExtensionResult<T[]>>;
	readOne<T = unknown>(
		collection: string,
		key: string | number,
		query?: ExtensionQuery
	): Promise<ExtensionResult<T | null>>;
};

export type ExtensionSettingsClient = {
	get<T = unknown>(key: string): Promise<ExtensionResult<T | ExtensionSecretReference | null>>;
};

/**
 * How a host delivers a sensitive value: `raw` to full-authority code,
 * `reference` as an opaque handle the host resolves, `brokered` used host-side
 * without revealing it. A delivery contract, not a storage guarantee.
 */
export type ExtensionFieldDelivery = 'raw' | 'reference' | 'brokered';

/** Opaque handle for a sensitive value the host resolves or uses on the extension's behalf. Serializable protocol data, not a stored placeholder or raw value. */
export type ExtensionSecretReference = {
	kind: 'secret-reference';
	ref: string;
};

/** The brokered host surface handed to a server extension. Each member is a method client. */
export type ExtensionHostApi = {
	log: ExtensionLogger;
	request: ExtensionRequestClient;
	items: ExtensionItemsClient;
	settings: ExtensionSettingsClient;
};

export type ExtensionInvocationContext = {
	extensionId: string;
	contributionId: string;
	activation: ExtensionActivation;
	accountability: ExtensionAccountability | null;
	host: ExtensionHostApi;
};

export type FlowOperationPayload<Options, Input> = {
	options: Options;
	input: Input;
};

export type FlowOperationHandler<Options, Input, Output> = (
	payload: FlowOperationPayload<Options, Input>,
	context: ExtensionInvocationContext
) => Output | Promise<Output>;

export type FlowOperationConfig<Options = Record<string, unknown>, Input = unknown, Output = unknown> = {
	id: string;
	handler: FlowOperationHandler<Options, Input, Output>;
};

export function defineFlowOperation<Options = Record<string, unknown>, Input = unknown, Output = unknown>(
	config: FlowOperationConfig<Options, Input, Output>
): FlowOperationConfig<Options, Input, Output> {
	return config;
}

export type JsonEndpointRequest<Input = unknown> = {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	path: string;
	query: Record<string, string>;
	body: Input;
};

export type JsonEndpointResult<Output = unknown> = {
	status?: number;
	body: Output;
};

export type JsonEndpointHandler<Input, Output> = (
	request: JsonEndpointRequest<Input>,
	context: ExtensionInvocationContext
) => JsonEndpointResult<Output> | Promise<JsonEndpointResult<Output>>;

export type JsonEndpointConfig<Input = unknown, Output = unknown> = {
	id: string;
	handler: JsonEndpointHandler<Input, Output>;
};
