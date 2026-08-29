---
title: Realtime authentication
description: The three authentication modes across both transports. Credential location, the initialization flow, token renewal, static tokens, timeouts, and the upgrade rejection rules.
sidebar:
  label: Authentication
  order: 1
---

Each transport is configured with one of three authentication modes. The mode decides when and how a client presents credentials, and what a connection can do before it does. Credentials are always an access token. Email and password, and a token passed in the query string, are not accepted over the socket.

The mode is set per transport with `WEBSOCKETS_REST_AUTH` (item protocol) and `WEBSOCKETS_GRAPHQL_AUTH` (GraphQL). See [Manage configuration](/docs/manage/configuration/#realtime-websockets) for the variables and timeouts.

## The three modes

- **`public`** — the connection opens anonymously and acts with the public role's permissions. A client can authenticate to elevate to a user's permissions. How and when depends on the transport (see below): the item protocol accepts an authentication frame at any time, while GraphQL authenticates only through the opening `connection_init`.
- **`handshake`** — the connection opens, then the client authenticates with its first message. This is the default. Until the first message authenticates, the connection is not yet usable.
- **`strict`** — a Bearer token is required at the HTTP upgrade, before the socket opens. A connection that reaches the open state under `strict` is already authenticated.

## By transport

### Item protocol (`/websocket`)

- **`public`** — connect and use the socket anonymously. To elevate, send an authentication frame:

  ```json
  { "type": "auth", "access_token": "<token>" }
  ```

  The server replies with `{ "type": "auth", "status": "ok" }`.

- **`handshake`** — send the same authentication frame as the first message. The connection is not usable until the `{ "type": "auth", "status": "ok" }` acknowledgement arrives. An invalid or expired token returns an error frame with code `AUTH_FAILED`.

- **`strict`** — present the token as an `Authorization: Bearer <token>` header on the upgrade request. There is no in-band initial authentication frame, and the socket opens only once the upgrade token is accepted. A later token refresh for the same user uses an `auth` frame, described under Token renewal.

### GraphQL subscriptions (`/graphql`)

The GraphQL transport uses `graphql-transport-ws`, so credentials travel in `connection_init`. The `connection_init` must arrive within the authentication timeout, or the connection is closed. There is no later in-band authentication on this transport. To change credentials, reconnect.

- **`public`** — connect anonymously. To elevate, include the token in the `connection_init` payload:

  ```json
  { "type": "connection_init", "payload": { "access_token": "<token>" } }
  ```

- **`handshake`** — include the token in the `connection_init` payload as above. This is the credential-bearing first message.

- **`strict`** — present the token as an `Authorization: Bearer <token>` header on the upgrade. Do not also put a token in `connection_init`: under `strict`, a token in the init payload is rejected and the connection is closed with code `4403`.

## Token renewal

An access token expires. How a connection renews depends on the transport.

- **Item protocol** — re-authenticate in-band by sending another `auth` frame with a fresh token on the open connection, in any mode. A successful re-authentication updates the connection's permissions in place. A `strict` connection uses the same flow to refresh credentials for its established user after the upgrade.
- **GraphQL** — there is no in-band re-authentication. Renew by reconnecting with a fresh token.

On the item protocol, a `public` connection whose re-authentication fails or times out returns to anonymous access rather than closing, while a `handshake` or `strict` connection closes on a re-authentication timeout.

The item protocol uses `TOKEN_EXPIRED` only after the connection has authenticated successfully. A credential for a different user returns `AUTH_FAILED` and closes the connection in every mode.

## Connection behavior by mode

Use this table to choose how a connection authenticates and recovers. For exact error frames, close codes, and upgrade statuses, see the [item protocol](/docs/api/realtime/item-protocol/#responses-and-errors), [GraphQL close codes](/docs/api/realtime/graphql/#close-codes), and [upgrade rejection rules](#upgrade-rejection-rules).

| Mode | Item protocol | GraphQL |
| --- | --- | --- |
| `public` | Starts anonymously. Failed authentication or expiry returns it to anonymous access. The connection can reauthenticate in-band as the same user. | Starts anonymously. An invalid credential in `connection_init` closes the connection. Expiry returns it to anonymous access. Reconnect to restore authenticated access. |
| `handshake` | The first message must authenticate. Failure or expiry closes the connection. The connection can refresh in-band as the same user. | `connection_init` must authenticate. Failure or expiry closes the connection. Reconnect to renew. |
| `strict` | A missing or invalid Bearer token rejects the upgrade. The connection can refresh in-band as the same user. Failure or expiry closes the connection. | A missing or invalid Bearer token rejects the upgrade. `connection_init` carries no credential. Expiry closes the connection. Reconnect to renew. |

## Static tokens

A static token is a non-expiring access token tied directly to a user record. Before each application command and each delivery read, CairnCMS reloads that user. Deleting the user, setting it inactive, or replacing its token invalidates the connection's identity, while changes to the user's role, admin, or app-access are adopted. These take effect on the connection's next command or delivery, not the moment the database row changes. A static token cannot refresh itself, so once its identity is invalidated the connection stops acting as that user on its next unit of work.

Static-token invalidation follows the mode-specific expiry behaviour above. A `public` connection returns to anonymous access, while a `handshake` or `strict` connection closes. The item protocol emits `TOKEN_EXPIRED`. GraphQL has no in-band renewal, so restoring authenticated access requires a new connection.

## Timeouts

Each authentication checkpoint is bounded by `WEBSOCKETS_REST_AUTH_TIMEOUT` or `WEBSOCKETS_GRAPHQL_AUTH_TIMEOUT`. In `strict` mode the checkpoint is at the upgrade, and a timeout rejects the upgrade. In `handshake` mode a timeout on the first-message authentication closes the connection. The timeout bounds each checkpoint independently, not the connection as a whole. See [Manage configuration](/docs/manage/configuration/#realtime-websockets) for the exact bounds and defaults.

## Upgrade rejection rules

Several checks happen at the HTTP upgrade, before any WebSocket frames, so a rejection is an HTTP status on the upgrade response, not a close code. The origin, query-token, rate-limit, and capacity checks apply in every mode. The credential check is additional under `strict`.

- **A disallowed `Origin`** — `403`, in every mode.
- **A token supplied in the query string** — `400`, in every mode. Query-string tokens are not accepted.
- **The shared rate-limit budget exhausted** — `429`. Realtime upgrades draw on the same `RATE_LIMITER_*` budget as HTTP.
- **Transport, process, or IP connection capacity is unavailable** — `503`.
- **`strict` only: the authenticated-user connection limit is reached** — `503`.
- **`strict` only: no `Authorization` header, an invalid Bearer token, or cookie-only credentials** — `401`. Cookies are not accepted as a WebSocket credential.

In `public` and `handshake` modes, the user connection limit is instead checked during in-band authentication. If the user has reached that limit, the open connection closes with `1013`.

A request that passes these checks upgrades and opens. CairnCMS determines the server origin from an absolute `PUBLIC_URL`. Without one, it derives the origin from the request scheme and `Host` header. Behind a trusted proxy, `X-Forwarded-Proto` affects that scheme only when `IP_TRUST_PROXY` trusts the proxy, so configure the proxy as described in [reverse-proxy configuration](/docs/api/realtime/reliability/#configure-a-reverse-proxy). A matching `Origin` is accepted. A different origin is accepted only when `CORS_ENABLED` is on and `CORS_ORIGIN` allows it. A request without an `Origin` is accepted for non-browser clients. A malformed or multiple `Origin` is rejected.

## Public mode exposure

`public` opens the transport to anonymous connections, which then act with the public role's permissions. Only enable it when the public role's read access is intended to be world-readable in real time, and keep the public role's permissions tight. `handshake` is the default because it requires a credential before the connection is usable.

## Permissions

Once authenticated, a connection acts with the token's user and role. Delivered payloads are read under the connection's current permissions, so a connection only receives item data it is allowed to read. See [Subscription authorization](/docs/api/realtime/subscriptions/) for how permission filters shape delivery and how the delete feed is gated.

## Authentication extensions

The `authenticate` extension filter runs on HTTP requests only. Realtime connections do not call it. They authenticate CairnCMS access tokens directly and use roles and permissions to determine access.

This means a custom credential accepted by the filter works for HTTP requests but cannot open a realtime connection. A restriction added by the filter also applies only to HTTP requests, even when the same access token is used over WebSockets.

Put every access restriction that must apply to both HTTP and realtime connections in CairnCMS roles and permissions. If that is not possible, leave authenticated WebSockets disabled.

## Where to go next

- [Subscription authorization](/docs/api/realtime/subscriptions/) — permission checks, row-level filters, and delete-feed eligibility.
- [Item protocol](/docs/api/realtime/item-protocol/) — authentication frames and item-protocol errors.
- [GraphQL subscriptions](/docs/api/realtime/graphql/) — `connection_init`, renewal, and GraphQL close codes.
- [Manage configuration](/docs/manage/configuration/#realtime-websockets) — authentication modes, timeouts, paths, and connection limits.
