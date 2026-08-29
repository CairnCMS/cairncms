---
title: GraphQL subscriptions
description: The graphql-transport-ws reference on /graphql. connection_init, the _mutated subscription field, event arguments and selections, the delete shape, the query and introspection gates, and reconnect-only renewal.
sidebar:
  label: GraphQL subscriptions
  order: 4
---

The GraphQL transport serves subscriptions over `graphql-transport-ws` on `/graphql`. It carries subscriptions only, not the item CRUD operations that the [item protocol](/docs/api/realtime/item-protocol/) offers. It is configured by the `WEBSOCKETS_GRAPHQL_*` family (see [Manage configuration](/docs/manage/configuration/#realtime-websockets)).

A GraphQL subscription receives no initial snapshot. It receives the change events only, in the shape of the selection set.

## Connecting

Open a WebSocket to `/graphql` with the `graphql-transport-ws` subprotocol, then send `connection_init`. Under `handshake` or `public`, the access token travels in the init payload:

```json
{ "type": "connection_init", "payload": { "access_token": "<token>" } }
```

Under `strict`, present the token as an `Authorization: Bearer` header at the upgrade and send `connection_init` with no token in the payload. The server answers with `connection_ack`.

## The subscription field

Each subscribable collection exposes a `<collection>_mutated` field on the `Subscription` root. It takes an optional `event` argument (`create`, `update`, or `delete`) and returns the changed record.

```graphql
subscription {
  articles_mutated(event: create) {
    event
    data {
      id
      title
    }
  }
}
```

The selection set chooses the fields to receive. `event` is the change kind. `data` is the changed item, selected field by field. Omit the `event` argument to receive create and update.

Standard GraphQL aliases and fragments work, and multiple `_mutated` subscriptions can run on one connection, each as its own operation.

## Delete events

A delete is delivered only when `event: delete` is requested. Because a deleted item cannot be read back, the delete result carries the key and a null `data`:

```graphql
subscription {
  articles_mutated(event: delete) {
    event
    key
    data {
      id
    }
  }
}
```

A delivered delete has the exact shape `{ "event": "delete", "key": "<id>", "data": null }`. The `key` is the deleted primary key as a string. The delete feed has eligibility rules described under [the delete feed](/docs/api/realtime/subscriptions/#the-delete-feed). An ineligible delete subscription returns a `FORBIDDEN` error.

## Scope

The GraphQL subscription surface is scoped to items, so a `<collection>_mutated` field exists for item collections only. The dashboards, notifications, operations, panels, and shares scopes that the item protocol can observe are not exposed here. Use the item protocol for those.

## Gates and redaction

The GraphQL WebSocket surface enforces the same guards as the GraphQL HTTP endpoint:

- **Query token limit.** A subscription document larger than `GRAPHQL_QUERY_TOKEN_LIMIT` is rejected.
- **Introspection.** When `GRAPHQL_INTROSPECTION` is off, an introspecting document is rejected.
- **Error redaction.** Internal error detail is redacted from the error sent to the client.

## Renewal

GraphQL has no in-band reauthentication. In `public` mode, expiry drops the connection to anonymous access without a notice frame. Reconnect with a fresh token and resubscribe to restore authenticated access. In `handshake` and `strict`, expiry closes the connection and requires a reconnect. See the [authentication table](/docs/api/realtime/authentication/#connection-behavior-by-mode) for the full mode-specific outcomes.

## Close codes

The GraphQL transport uses the `graphql-transport-ws` close codes. The ones to expect:

- **`4400`** — a malformed frame, or a frame that is not valid for the protocol state.
- **`4401`** — a `subscribe` was sent before the connection was acknowledged.
- **`4403`** — forbidden: an authentication failure at `connection_init`, or a token supplied under `strict`.
- **`4408`** — connection-initialisation timeout: no `connection_init` arrived within the deadline. This applies under `public` and `strict`. Under `handshake` the `graphql-transport-ws` init timer is disabled and the base authentication deadline applies instead, so a handshake connection that never authenticates closes on that deadline without this protocol code.
- **`4409`** — a `subscribe` reused an operation `id` that is already active on the connection.
- **`4429`** — more than one `connection_init` was sent.
- **`1009`** — an outbound frame would exceed the 1 MiB frame bound.
- **`1013`** — try again later, when capacity, a rate limit, or the pending-command limit is exceeded.
- **`4500`** — an internal error while delivering a subscription.

The `4400`, `4403`, `1013`, and `4500` closes come from CairnCMS. The `4401`, `4408`, `4409`, and `4429` closes come from the `graphql-transport-ws` protocol layer, and `1009` from the shared outbound-frame guard.

On any close, reconnect and resubscribe, then reread current state. A subscription is ended cleanly with the protocol's `complete` message.

## Where to go next

- [Subscription authorization](/docs/api/realtime/subscriptions/) — permission checks, row-level filters, and delete-feed eligibility.
- [Authentication](/docs/api/realtime/authentication/) — `connection_init`, strict upgrades, and token renewal.
- [GraphQL API](/docs/api/graphql/) — queries, mutations, schema exposure, and HTTP GraphQL behavior.
- [Reliability](/docs/api/realtime/reliability/) — deployment, limits, and recovery.
