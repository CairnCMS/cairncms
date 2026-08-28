---
title: Realtime SDK
description: The realtime() composable in @cairncms/sdk. Setup, connect and subscribe, the async-generator stream, onWebSocket, configuration, reconnect behavior, and the type-safe delete feed.
sidebar:
  label: SDK
  order: 5
---

[`@cairncms/sdk`](/docs/api/sdk/) provides a realtime client through the `realtime()` composable. It uses the item transport, so it speaks the [item protocol](/docs/api/realtime/item-protocol/) on `/websocket`, and it supports the `public` and `handshake` authentication modes. The `strict` mode is a server-side upgrade contract exercised by a raw client, not the SDK.

## Setup

Compose a client with an authentication composable and `realtime()`:

```ts
import { createCairnCMS, staticToken, realtime } from '@cairncms/sdk';

const client = createCairnCMS('https://example.com')
  .with(staticToken('<token>'))
  .with(realtime({ authMode: 'handshake' }));
```

Use `staticToken` for a fixed token, or the `authentication` composable when the client also manages a login and refresh lifecycle. The realtime client reads the token from whichever authentication composable is present.

### Node

In the browser the SDK uses the global `WebSocket`. In Node, supply a WebSocket implementation through `globals`:

```ts
import { WebSocket } from 'ws';

const client = createCairnCMS('https://example.com', { globals: { WebSocket } })
  .with(staticToken('<token>'))
  .with(realtime({ authMode: 'handshake' }));
```

## Connect and subscribe

```ts
await client.connect();

const { subscription, unsubscribe } = await client.subscribe('articles');

for await (const message of subscription) {
  console.log(message);
}
```

`subscribe` returns an async generator and an `unsubscribe` function. Iterating the generator yields each message in order. Call `unsubscribe()` to end the subscription, and `client.disconnect()` to close the connection. The client is reusable after a disconnect: connect again and resubscribe.

The methods:

- **`connect()`** — open the connection and authenticate.
- **`disconnect()`** — close the connection. It stays closed until the next `connect()`.
- **`isConnected()`** — whether the connection is currently open.
- **`subscribe(collection, options?)`** — start a subscription. Returns `{ subscription, unsubscribe }`.
- **`onWebSocket(event, handler)`** — attach a handler for a raw socket event (`open`, `close`, `error`, `message`). Returns a function that removes the handler.
- **`sendMessage(message)`** — send a raw item-protocol frame.

## Subscription options

```ts
await client.subscribe('articles', { event: 'update', uid: 'a1' });
await client.subscribe('articles', { query: { filter: { status: { _eq: 'published' } }, fields: ['id', 'title'] } });
```

- **`event`** — `create`, `update`, or `delete`.
- **`query`** — a filter and field selection.
- **`uid`** — an identifier to tell concurrent subscriptions apart.

## The type-safe delete feed

The subscription types encode the [delete feed](/docs/api/realtime/subscriptions/#the-delete-feed) rules, so misuse is a compile error rather than a runtime rejection:

- A `delete` subscription cannot carry a `query`. A `query` and `delete` combination does not type-check.
- A subscription with a `query`, or with no `event`, has no `delete` variant in its output type.
- A `delete` subscription yields a payload of deleted primary keys, not item data.

Delete-feed eligibility comes from an unconditional read permission, not from `items.query` or `items.read` hooks, which the delete feed does not run. A restriction expressed only through those hooks does not narrow the delete feed. See [the delete feed](/docs/api/realtime/subscriptions/#the-delete-feed).

## Configuration

`realtime()` takes a config object:

- **`authMode`** — `public` or `handshake`. Default `handshake`.
- **`reconnect`** — `{ delay, retries }` to enable automatic reconnect, or `false`. Default `false`.
- **`connect`** — `{ timeout }` in milliseconds for the connect attempt, or `false`.
- **`heartbeat`** — whether the client answers application-level ping messages. Default on. The server's own heartbeat uses WebSocket control frames, which the underlying WebSocket answers automatically, independently of this option.
- **`debug`** — enable diagnostic logging.

Only enable `public` when the public role's read access is meant to be world-readable in real time. `handshake` is the default because it requires a credential before the connection is usable.

## Reconnect and recovery

Automatic reconnect is off by default. When enabled, the client makes a single bounded series of attempts after an unexpected close, with a jittered backoff, and replays its active subscriptions on success. A manual `disconnect()` does not reconnect.

Reconnect replays subscriptions, not missed events. The client does not receive changes that occurred while it was disconnected. On reconnect, reread current state. This is the [delivery model](/docs/api/realtime/#delivery-model): the notification stream is a prompt to reread, not a durable log.

## Where to go next

- [Item protocol](/docs/api/realtime/item-protocol/) — the frames and operations used by the SDK.
- [Authentication](/docs/api/realtime/authentication/) — public and handshake authentication behavior.
- [Subscription authorization](/docs/api/realtime/subscriptions/) — permission checks and delete-feed eligibility.
- [Reliability](/docs/api/realtime/reliability/) — reconnection, multiple instances, and operational limits.
