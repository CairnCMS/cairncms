---
title: Realtime reliability
description: Configure realtime across one or more API instances, understand its resource limits, and plan client recovery.
sidebar:
  label: Reliability
  order: 7
---

Use this page when deploying realtime. It covers transport setup, multi-instance delivery, resource limits, reverse proxies, and client recovery. See [Manage configuration](/docs/manage/configuration/#realtime-websockets) for the complete environment-variable reference.

## Enable realtime

Realtime is off by default. Set `WEBSOCKETS_ENABLED=true` to enable it. The item and GraphQL transports can then be enabled or disabled independently and assigned separate upgrade paths. Their default paths are `/websocket` and `/graphql`.

The paths must differ. If they match, CairnCMS disables GraphQL and keeps the item transport available. An invalid shared setting disables realtime, while an invalid transport setting disables only that transport. HTTP remains available in either case.

## Run multiple API instances

Configure the Redis messenger when running more than one API instance. It distributes each change to subscribers connected to every instance. Without Redis, an instance can deliver only the changes produced on that same instance.

Redis distributes notifications but does not combine resource counters. Every API process enforces its own connection, subscription, queue, and dispatch limits. Total capacity therefore grows with the number of instances, and a user or client IP can reach the admission limit separately on each instance. Use a reverse proxy when you also need a cluster-wide connection limit.

## Understand the limits

Realtime uses finite limits to protect each API process:

- **Connections** are capped per transport and API process. Anonymous and pre-authentication connections use the client IP limit. Authenticated connections use the stable user limit.
- **Subscriptions** are capped per connection and API process.
- **Inbound messages** use the shared `MAX_PAYLOAD_SIZE`.
- **Outbound frames** are limited to 1 MiB. An oversized frame closes the affected connection with `1009` before the frame is sent.
- **Outbound queues** are bounded per connection. A slow consumer whose queue fills is closed with `1013`.

When a connection limit is reached, CairnCMS refuses the new connection. Message-rate behavior differs by transport: an established item-protocol connection receives `REQUESTS_EXCEEDED` and stays open, while a GraphQL connection closes with `1013`.

Connection limits and the shared `MAX_PAYLOAD_SIZE` are operator-configurable. Subscription, outbound-frame, and outbound-queue bounds are fixed. Raising a configurable limit permits more concurrent or per-message work, so account for the instance's memory, file descriptors, and database capacity. See [Manage configuration](/docs/manage/configuration/#realtime-websockets) for the settings and defaults.

## Configure a reverse proxy

A WebSocket connection starts as an HTTP upgrade request. Configure the reverse proxy to:

- Forward the `Upgrade` and `Connection` headers on both realtime paths.
- Disable response buffering for WebSocket connections.
- Set the idle or read timeout longer than `WEBSOCKETS_HEARTBEAT_PERIOD`.
- Preserve the `Authorization` and `Origin` headers when using `strict` authentication or origin checks.

## Plan recovery

CairnCMS treats the database as authoritative, so realtime does not store or replay notifications. Applications maintain current state through API reads and choose when to reconnect or reconcile.

- **Restart or deployment** closes existing connections. The server does not queue missed notifications for later delivery.
- **Local overload** closes every subscribed connection on the affected process with `1013` when its source-event queue fills. That process refuses new events and subscriptions until it recovers.
- **Messenger interruption** can drop a notification without closing the client connection. Check `/server/health` and the API logs when cross-instance delivery is degraded.
- **Connection failure** from a network interruption, resource limit, or oversized frame ends the active subscriptions on that socket.

After a close, the application decides whether to reconnect, register its subscriptions again, and reread current state. Applications with stricter freshness requirements should also reconcile on their own schedule because a messenger interruption may not close the socket. See the [delivery model](/docs/api/realtime/#delivery-model) for the broader application pattern.

## Where to go next

- [Manage configuration](/docs/manage/configuration/#realtime-websockets) — transport settings, limits, timeouts, and Redis messenger configuration.
- [Deployment](/docs/manage/deployment/) — production topology, networking, and service dependencies.
- [Authentication](/docs/api/realtime/authentication/) — credential handling and transport authentication modes.
- [SDK](/docs/api/realtime/sdk/) — reconnect behavior in the JavaScript client.
