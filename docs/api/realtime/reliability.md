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

Enabling `WEBSOCKETS_ENABLED` while disabling both transports serves no realtime path. Leave at least one transport enabled.

## Run multiple API instances

Configure the Redis messenger when running more than one API instance. It distributes each change to subscribers connected to every instance. Without Redis, an instance can deliver only the changes produced on that same instance.

Redis distributes notifications but does not combine resource counters. Every API process enforces its own connection and subscription capacity. Total capacity therefore grows with the number of instances, and a user or client IP can reach the admission limit separately on each instance. Use a reverse proxy when you also need a cluster-wide connection limit.

## Plan capacity

Each API process enforces its own realtime limits. Connection limits and `MAX_PAYLOAD_SIZE` are configurable. See [Manage configuration](/docs/manage/configuration/#realtime-websockets) for their settings and defaults.

- A connection can hold up to 100 subscriptions, and an API process can hold up to 10,000.
- Outbound frames are limited to 1 MiB. An oversized frame closes the connection with `1009` before sending the frame.
- CairnCMS bounds queued work to protect the API process. A slow consumer or local overload can close an affected connection with `1013`.

When CairnCMS cannot admit a connection because capacity is unavailable, it refuses the HTTP upgrade with `503`. Capacity reached after the socket opens can close it with `1013`. See [Authentication](/docs/api/realtime/authentication/#connection-behavior-by-mode) for how this applies to each mode.

Realtime uses the same `RATE_LIMITER_*` budget as HTTP. An exhausted budget can reject an upgrade with `429`. Once connected, the item protocol reports `REQUESTS_EXCEEDED`, while GraphQL closes with `1013`.

Raising a configurable limit permits more concurrent or per-message work. Account for the instance's memory, file descriptors, and database capacity.

## Configure a reverse proxy

A WebSocket connection starts as an HTTP upgrade request. Configure the reverse proxy to:

- Forward the `Upgrade` and `Connection` headers on both realtime paths.
- Disable response buffering for WebSocket connections.
- Set the idle or read timeout longer than `WEBSOCKETS_HEARTBEAT_PERIOD`.
- Preserve the `Authorization` and `Origin` headers when using `strict` authentication or origin checks.
- If `PUBLIC_URL` does not provide an absolute server origin, forward `X-Forwarded-Proto` and configure `IP_TRUST_PROXY` so CairnCMS can derive the external request scheme. Without that trusted header, a TLS-terminating proxy appears as `http` to CairnCMS and can cause a legitimate `https` origin to be rejected.

## Plan recovery

CairnCMS treats the database as authoritative, so realtime does not store or replay notifications. Applications maintain current state through API reads and choose when to reconnect or reconcile.

- **Restart or deployment** closes existing connections. The server does not queue missed notifications for later delivery.
- **Local overload** closes subscribed connections on the affected process with `1013`. That process refuses new events and subscriptions until it recovers.
- **Messenger interruption** can drop a notification without closing the client connection. Check `/server/health` and the API logs when cross-instance delivery is degraded.
- **Connection failure** from a network interruption, resource limit, or oversized frame ends the active subscriptions on that socket.

After a close, the application decides whether to reconnect, register its subscriptions again, and reread current state. Applications with stricter freshness requirements should also reconcile on their own schedule because a messenger interruption may not close the socket. See the [delivery model](/docs/api/realtime/#delivery-model) for the broader application pattern.

## Where to go next

- [Manage configuration](/docs/manage/configuration/#realtime-websockets) — transport settings, limits, timeouts, and Redis messenger configuration.
- [Deployment](/docs/manage/deployment/) — production topology, networking, and service dependencies.
- [Authentication](/docs/api/realtime/authentication/) — credential handling and transport authentication modes.
- [SDK](/docs/api/realtime/sdk/) — reconnect behavior in the JavaScript client.
