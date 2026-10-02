---
title: Realtime
description: Subscribe to collection changes over a WebSocket. The two transports, the three authentication modes, the subscription model, the SDK, the extension surface, and the database-authoritative recovery contract.
sidebar:
  label: Overview
  order: 0
---

CairnCMS can push change notifications to connected clients over a WebSocket, so an interface can update as data changes instead of polling. A client opens a persistent connection, subscribes to one or more collections, and receives a message whenever a matching item is created, updated, or deleted.

Realtime is off by default. It is enabled per deployment through the `WEBSOCKETS_*` configuration, documented in [Manage configuration](/docs/manage/configuration/#realtime-websockets). This section is the usage and protocol reference for what that surface exposes.

## Delivery model

Realtime lets applications respond quickly to changes without polling continuously. The database remains authoritative, and each notification tells the client when to reread current state.

- **Responsive updates.** Subscribe to the collections that matter and use each message to refresh the relevant data.
- **Deployment-sized throughput.** Notification timing reflects result-set size, query cost, subscriber count, and available capacity. Operators size the deployment for the expected workload.
- **Application-owned freshness.** Notifications are not stored or replayed and can be missed during a disconnect, overload, or messenger outage. Clients reconnect, resubscribe, and reread after an interruption. Applications that need tighter freshness can also reconcile on their own schedule.

See [Reliability](/docs/api/realtime/reliability/) for deployment and recovery guidance.

## Choose a transport

Use the **item protocol** for the CairnCMS SDK, initial snapshots, item operations over the socket, or change notifications from dashboards, notifications, operations, panels, and shares.

Use **GraphQL subscriptions** when your client already uses `graphql-transport-ws` and you want selection-set-shaped notifications for item collections.

Both transports use the same authentication modes and permission-checked delivery. See [Subscription authorization](/docs/api/realtime/subscriptions/) for their shared permission, delete-feed, and ordering rules.

## Authentication at a glance

Each transport is configured with one of three authentication modes. Credentials are always an access token. There is no email and password or query-string token over the socket.

- **`public`** — anonymous. The connection has the permissions of the public role until a token is supplied.
- **`handshake`** — authenticate with the first message. The default.
- **`strict`** — a Bearer token is required at the upgrade, before the socket opens.

The [Authentication](/docs/api/realtime/authentication/) page covers the exact credential location and flow for each mode and transport, token renewal, and the rejection rules.

## A minimal client

Using [`@cairncms/sdk`](/docs/api/realtime/sdk/):

```ts
import { createCairnCMS, staticToken, realtime } from '@cairncms/sdk';

const client = createCairnCMS('https://example.com')
  .with(staticToken('<token>'))
  .with(realtime({ authMode: 'handshake' }));

await client.connect();

const { subscription } = await client.subscribe('articles');

for await (const message of subscription) {
  console.log(message);
}
```

The SDK realtime client uses the item protocol and supports the `public` and `handshake` modes. The `strict` mode is a server-side upgrade contract, exercised by a raw client rather than the SDK.

## Where to go next

- **[Authentication](/docs/api/realtime/authentication/)** — the three modes across both transports, credential location, renewal, and rejection rules.
- **[Subscription authorization](/docs/api/realtime/subscriptions/)** — permission-checked delivery, row-level filters, delete-feed eligibility, and ordering.
- **[Item protocol](/docs/api/realtime/item-protocol/)** — the `/websocket` JSON frame reference.
- **[GraphQL subscriptions](/docs/api/realtime/graphql/)** — the `/graphql` `graphql-transport-ws` reference.
- **[SDK](/docs/api/realtime/sdk/)** — the `realtime()` composable and the JavaScript client.
- **[Extensions](/docs/api/realtime/extensions/)** — the `WebSocketService` and the connection lifecycle hooks.
- **[Reliability](/docs/api/realtime/reliability/)** — enabling transports, multiple instances, limits, reverse proxies, and recovery.
- **[Manage configuration](/docs/manage/configuration/#realtime-websockets)** — the canonical transport settings, defaults, and limits.
