---
title: Realtime for extensions
description: The WebSocketService and the connection lifecycle hooks available to full-authority extensions. Broadcasting, enumerating clients, the per-hook transport boundary, and the inbound protocol boundary.
sidebar:
  label: Extensions
  order: 6
---

A full-authority extension can observe realtime connections and push messages to them through `WebSocketService`. As of the time of this writing, confined extensions cannot access it.

Obtain the service from the extension context and construct it:

```ts
const websocket = new context.services.WebSocketService();
```

The class is available even when the realtime feature is inactive. The broadcasting methods require the item transport to be active and throw a service-unavailable error otherwise.

## Lifecycle hooks

Register a handler for a connection lifecycle event with `on`. The handler receives an object carrying the `client` and any event-specific fields:

```ts
function onConnect({ client }) {
  registerPresence(client);
}

websocket.on('connect', onConnect);
```

Remove a handler by passing the same callback reference to `off`, as in `websocket.off('connect', onConnect)`.

The events are `connect`, `message`, `error`, and `close`, and their transport coverage is not uniform:

- **`connect`, `error`, `close`** fire for both transports. A handler sees the lifecycle of item-protocol and GraphQL connections alike, and the event does not indicate which transport a connection used.
- **`message`** fires for the item transport only.

`on('message')` observes a message after its command has run. Separately, a full-authority extension can register a `websocket.message` filter to inspect or modify a parsed item-protocol message before it is handled. Neither adds a new inbound protocol.

## Broadcasting

`broadcast` sends a message to connected clients on the item transport. Pass a JSON-serializable message and an optional filter to target a single user or role:

```ts
websocket.broadcast({ type: 'announcement', text: 'Deploying in 5 minutes' });
websocket.broadcast({ type: 'announcement', text: 'Admins only' }, { role: '<role-id>' });
```

`clients()` returns the set of connected item-transport clients, for inspection or custom targeting:

```ts
const connected = websocket.clients();
```

`broadcast` and `clients` operate on the item transport. They do not reach GraphQL connections, and they throw if the item transport is not active.

## Inbound protocol boundary

`WebSocketService` supports lifecycle observation and outbound broadcasts. The item protocol and GraphQL are the two inbound message protocols the platform serves, and an extension cannot add a third or replace their frame handling.

## Where to go next

- [Extension services](/docs/develop/extensions/server-extensions/services/) — the full service catalog available to server extensions.
- [Hooks](/docs/develop/extensions/server-extensions/hooks/) — registering actions and filters in a server extension.
- [Item protocol](/docs/api/realtime/item-protocol/) — the inbound frames observed by item-protocol message hooks.
