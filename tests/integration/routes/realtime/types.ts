import type { Query } from '@cairncms/types';
import type { ClientOptions } from 'ws';
import type { ClientOptions as ClientOptionsGql } from 'graphql-ws';

export type PrimaryKeyType = 'integer' | 'uuid' | 'string';

export type WebSocketAuthMethod = 'public' | 'handshake' | 'strict';

export type WebSocketUID = string | number;

export type WebSocketResponse = {
	type: string;
	status?: string;
	uid?: WebSocketUID;
	event?: string;
	[field: string]: any;
};

export type WebSocketDefaultOptions = {
	authMode?: 'handshake' | 'strict';
	auth?: { access_token: string };
	path?: string;
	queryString?: string;
	waitTimeout?: number;
};

export type WebSocketOptions = WebSocketDefaultOptions & {
	client?: ClientOptions;
};

export type WebSocketOptionsGql = WebSocketDefaultOptions & {
	client?: ClientOptionsGql;
};

export type WebSocketSubscriptionOptions = {
	collection: string;
	item?: string | number;
	query?: Query;
	uid?: WebSocketUID;
	event?: 'create' | 'update' | 'delete';
};

export type WebSocketSubscriptionOptionsGql = {
	collection: string;
	jsonQuery: any;
	uid?: WebSocketUID;
	event?: 'create' | 'update' | 'delete';
	protocolId?: string;
};
