---
title: Item protocol
description: The JSON frame reference for the item transport on /websocket. Authentication, subscriptions, item CRUD, the response and error envelopes, uid, heartbeat, and close codes.
sidebar:
  label: Item protocol
  order: 3
---

The item transport is a JSON message protocol on `/websocket`. It carries authentication, subscriptions, and item CRUD and query operations over one persistent connection. It is configured by the `WEBSOCKETS_REST_*` family (see [Manage configuration](/docs/manage/configuration/#realtime-websockets)).

Every message is a single JSON object with a `type`. A client may attach a `uid` to any message it sends, and the server echoes that `uid` on the responses and on the subscription messages it produces, so a client can correlate a stream of messages to the request that started it.

## Connecting

Open a WebSocket to the configured path, using `wss://` in production:

```
wss://example.com/websocket
```

What happens next depends on the [authentication mode](/docs/api/realtime/authentication/). Under `strict` the token is presented as an `Authorization: Bearer` header at the upgrade. Under `handshake` the first frame authenticates. Under `public` the connection is usable immediately and a token may be supplied later.

## Authentication

```json
{ "type": "auth", "access_token": "<token>" }
```

The server replies:

```json
{ "type": "auth", "status": "ok" }
```

A failed authentication returns an [error frame](#responses-and-errors) with code `AUTH_FAILED`, and an expired token returns `TOKEN_EXPIRED`. Re-authenticate at any time by sending another `auth` frame with a fresh token.

## Subscriptions

Subscribe to a collection:

```json
{ "type": "subscribe", "collection": "articles", "uid": "a1" }
```

Optional fields narrow the subscription:

- **`event`** — one of `create`, `update`, `delete`. Omit to receive create and update.
- **`item`** — a single primary key to watch.
- **`query`** — a filter and field selection, using the [query DSL](/docs/api/filters-and-queries/).

The server sends each subscription message as a separate frame. A subscription without an `event` filter starts with an initial snapshot:

```json
{ "type": "subscription", "event": "init", "data": [{ "id": 41, "title": "Existing" }], "uid": "a1" }
```

Later changes arrive in their own frames:

```json
{ "type": "subscription", "event": "create", "data": [ { "id": 42, "title": "New" } ], "uid": "a1" }
```

```json
{ "type": "subscription", "event": "update", "data": [ { "id": 42, "title": "Edited" } ], "uid": "a1" }
```

When an `event` filter is set, the `init` message is an acknowledgement with no snapshot (`{ "event": "init" }`), and only that event follows. Delete messages carry the deleted keys, not item data, and are delivered only to an `event: "delete"` subscription (see [the delete feed](/docs/api/realtime/subscriptions/#the-delete-feed)):

```json
{ "type": "subscription", "event": "delete", "data": [ 42 ], "uid": "d1" }
```

Unsubscribe with the same `uid`:

```json
{ "type": "unsubscribe", "uid": "a1" }
```

## Item operations

The item transport can run the same CRUD operations as the HTTP [items](/docs/api/items/) API, using `type: "items"` with an `action`. The server replies with a `type: "items"` message carrying the result under `data`.

Create:

```json
{ "type": "items", "collection": "articles", "action": "create", "data": { "title": "Hello" }, "uid": "c1" }
```

Read (by `id`, by `ids`, or by `query`):

```json
{ "type": "items", "collection": "articles", "action": "read", "query": { "filter": { "status": { "_eq": "published" } } }, "uid": "r1" }
```

Update (`data` is applied to the item or items named by `id`, `ids`, or `query`):

```json
{ "type": "items", "collection": "articles", "action": "update", "id": 42, "data": { "title": "Edited" }, "uid": "u1" }
```

Delete (by `id`, `ids`, or `query`):

```json
{ "type": "items", "collection": "articles", "action": "delete", "id": 42, "uid": "x1" }
```

Item operations are permission-checked exactly as the HTTP API is, under the connection's current role.

## Responses and errors

Not every message carries a `status`. An authentication acknowledgement is `{ "type": "auth", "status": "ok" }`. Item results and subscription messages have no `status` field and carry their `data` directly. An error is a message with `status: "error"` and a code:

```json
{ "type": "subscribe", "status": "error", "error": { "code": "DELETE_FEED_FORBIDDEN", "message": "Delete notifications are not available for this subscription." }, "uid": "d1" }
```

The `type` on an error is the type of the message that failed, so a client can route it by `type` and `uid`.

Most errors are informational and leave the connection open. A malformed frame, for example, returns `INVALID_PAYLOAD` and the connection keeps serving. A few conditions close the connection: an authentication failure during the handshake, and `TOO_MANY_PENDING`.

The error codes:

| Code | Meaning |
| --- | --- |
| `AUTH_FAILED` | The supplied token was rejected. |
| `TOKEN_EXPIRED` | The supplied token has expired. |
| `INVALID_PAYLOAD` | The message could not be parsed or failed validation. |
| `INVALID_COLLECTION` | The collection is not accessible to this connection. |
| `UNSUPPORTED_MESSAGE_TYPE` | The `type` is not a recognized message type. |
| `REQUESTS_EXCEEDED` | The connection exceeded its message rate limit. |
| `TOO_MANY_PENDING` | Too many commands are in flight on the connection. |
| `SUBSCRIPTION_LIMIT` | The subscription limit for the connection was reached. |
| `DELETE_FEED_FORBIDDEN` | The subscription is not eligible for delete notifications. |
| `INTERNAL_ERROR` | The request failed for an unexpected reason. |

## Heartbeat

The server sends WebSocket ping control frames at the interval set by `WEBSOCKETS_HEARTBEAT_PERIOD`. Standard WebSocket clients, including browsers and the `ws` library, answer them automatically, so no application code is needed. A connection that misses two heartbeat periods without a pong is closed.

## Close codes

The item transport reports recoverable errors as error frames and keeps the connection open. It closes the connection in a few cases:

- **`1013`** (try again later) — a connection-capacity limit is exceeded, or the server enters overload. An exceeded per-message rate limit does not close the connection: it returns a `REQUESTS_EXCEEDED` error frame instead.
- **`1009`** (message too big) — an outbound frame would exceed the 1 MiB frame bound, for example a very large initial snapshot.

A client that is closed should reconnect, resubscribe, and reread current state.

## Where to go next

- [SDK](/docs/api/realtime/sdk/) — the JavaScript client for the item protocol.
- [Subscription authorization](/docs/api/realtime/subscriptions/) — permission checks, row-level filters, and delete-feed eligibility.
- [Authentication](/docs/api/realtime/authentication/) — credential placement, renewal, and the three authentication modes.
- [Reliability](/docs/api/realtime/reliability/) — deployment, limits, and recovery.
