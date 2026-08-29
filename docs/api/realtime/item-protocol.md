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

A failed authentication returns an [error frame](#responses-and-errors) with code `AUTH_FAILED`. Before the connection has authenticated successfully, every rejected credential uses `AUTH_FAILED`, including an expired one. After the connection has authenticated as a user, an expired token uses `TOKEN_EXPIRED`, and any other invalid credential still uses `AUTH_FAILED`. See [Authentication](/docs/api/realtime/authentication/#connection-behavior-by-mode) for the full per-mode outcomes. Re-authenticate at any time by sending another `auth` frame with a fresh token.

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

The snapshot `data` is an array for a collection subscription. For an item-scoped subscription, one that sets `item`, `data` is the single item object instead. When the subscription's `query` requests `meta`, the `init` frame also carries a `meta` object with the standard query metadata.

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

An `unsubscribe` with a `uid` ends that one subscription. An `unsubscribe` with no `uid` ends every subscription on the connection. Either way the server acknowledges with `{ "type": "subscription", "event": "unsubscribe" }`, echoing the `uid` when one was sent.

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

Not every message carries a `status`. An authentication acknowledgement is `{ "type": "auth", "status": "ok" }`. Item results and subscription messages have no `status` field and carry their `data` directly. A read result, or a multi-item update, also carries a `meta` object when the request's `query` asks for it. An error is a message with `status: "error"` and a code:

```json
{ "type": "subscribe", "status": "error", "error": { "code": "DELETE_FEED_FORBIDDEN", "message": "Delete notifications are not available for this subscription." }, "uid": "d1" }
```

The `type` on an error is the type of the message that failed, so a client can route it by `type` and `uid`. A failure that is not tied to a routable command, such as a malformed frame, an unrecognized message type, or a rate or pending-command rejection, uses the type `server`.

Most errors are informational and leave the connection open. A malformed frame, for example, returns `INVALID_PAYLOAD` and the connection keeps serving. The conditions that end the connection are listed under [Close codes](#close-codes).

The error codes:

| Code | Meaning |
| --- | --- |
| `AUTH_FAILED` | The supplied token was rejected. |
| `TOKEN_EXPIRED` | The supplied token has expired. |
| `INVALID_PAYLOAD` | The message could not be parsed or failed validation. |
| `FORBIDDEN` | The request is not permitted. This response does not distinguish an unknown collection from one the connection cannot access. |
| `UNSUPPORTED_MESSAGE_TYPE` | The `type` is not a recognized message type. |
| `REQUESTS_EXCEEDED` | The connection exceeded its message rate limit. |
| `TOO_MANY_PENDING` | A command arrived while 10 others were already waiting. The connection then closes with `1013`. |
| `SUBSCRIPTION_LIMIT` | The subscription limit for the connection was reached. |
| `DELETE_FEED_FORBIDDEN` | The subscription is not eligible for delete notifications. |
| `INTERNAL_ERROR` | The request failed for an unexpected reason. |

## Heartbeat

The server sends WebSocket ping control frames at the interval set by `WEBSOCKETS_HEARTBEAT_PERIOD`. Standard WebSocket clients, including browsers and the `ws` library, answer them automatically, so no application code is needed. A connection that misses two heartbeat periods without a pong is closed.

## Close codes

Admission happens at the HTTP upgrade, before the socket opens, so a connection refused for a disallowed origin, a query-string token, an exhausted rate-limit budget, or unavailable transport, process, or IP capacity is rejected with an HTTP status, not a close code. See [upgrade rejection rules](/docs/api/realtime/authentication/#upgrade-rejection-rules).

Once the socket is open, the item transport reports recoverable errors as error frames and keeps the connection open. It closes the connection in these cases:

- **`1013`** (try again later) — the server sheds the connection under pressure. This covers pending-command overflow, which sends a `TOO_MANY_PENDING` frame first, an outbound queue that fills for a slow consumer, source-event overload on the process, a full authenticated-user bucket during `public` or `handshake` authentication, and a full client-IP bucket when a `public` connection falls back to anonymous access. After authentication, an exceeded per-message rate limit returns a `REQUESTS_EXCEEDED` error frame and leaves the connection open. During the `handshake` authentication, the same error closes the connection.
- **`1009`** (message too big) — an outbound frame would exceed the 1 MiB frame bound, for example a very large initial snapshot.
- **Authentication close** — under `handshake` and `strict`, a failed or timed-out authentication closes the connection, and a credential for a different user closes in every mode. See [Authentication](/docs/api/realtime/authentication/#connection-behavior-by-mode) for the per-mode outcomes.

See [Reliability](/docs/api/realtime/reliability/#plan-capacity) for deployment and recovery guidance. A client that is closed should reconnect, resubscribe, and reread current state.

## Where to go next

- [SDK](/docs/api/realtime/sdk/) — the JavaScript client for the item protocol.
- [Subscription authorization](/docs/api/realtime/subscriptions/) — permission checks, row-level filters, and delete-feed eligibility.
- [Authentication](/docs/api/realtime/authentication/) — credential placement, renewal, and the three authentication modes.
- [Reliability](/docs/api/realtime/reliability/) — deployment, limits, and recovery.
