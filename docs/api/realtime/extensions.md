---
title: Realtime for extensions
description: Realtime hooks and the WebSocketService surface available to full-authority extensions. Connection events, broadcasting, client access, and protocol boundaries.
sidebar:
  label: Extensions
  order: 6
---

A full-authority extension can observe realtime connections through hooks and send messages through `WebSocketService`. Confined extensions cannot access either realtime surface.

## Lifecycle hooks

In a hook extension, register realtime lifecycle handlers with `action`. The platform removes these handlers when the extension unloads.

```ts
import { defineHook } from '@cairncms/extensions-sdk';

export default defineHook(({ action }) => {
  action('websocket.connect', ({ client }) => {
    registerPresence(client);
  });
});
```

The available events and their transport coverage are:

- **`websocket.connect`, `websocket.error`, `websocket.close`** — action events for both transports. They do not include a trusted transport identifier. `client.protocol` holds the negotiated WebSocket subprotocol, not a transport tag, and must not be used alone to classify or authorize a connection.
- **`websocket.message`** — a filter before an item-protocol message is handled and an action after its command runs. It does not fire for GraphQL messages.
- **`websocket.auth.success`, `websocket.auth.failure`** — item-protocol action events. `websocket.auth.success` fires after successful post-connect authentication. `websocket.auth.failure` fires when a public connection rejects an in-band credential, returns to anonymous access, and remains open. A successful initial handshake emits `websocket.connect`, and an authentication that closes the connection emits neither auth event.

The `websocket` namespace is reserved for full-authority extensions. A confined extension cannot subscribe to `websocket` or any `websocket.*` event. See [sandboxed extensions](/docs/develop/extensions/server-extensions/sandbox/).

## Direct service listeners

`WebSocketService.on` exposes the shorter `connect`, `message`, `error`, and `close` event names. These follow the same transport coverage as the corresponding hook events.

```ts
const websocket = new context.services.WebSocketService();

function onConnect({ client }) {
  registerPresence(client);
}

websocket.on('connect', onConnect);
```

The extension owns listeners registered with `on`. Keep the callback reference and pass it to `off` when cleaning up, as in `websocket.off('connect', onConnect)`.

## Broadcasting

Obtain `WebSocketService` from the extension context. The class is available even when realtime is inactive, but its broadcasting methods require the item transport and throw a service-unavailable error otherwise. To detect active transports, read the `websocket` block of [`GET /server/info`](/docs/api/system-collections/platform-and-utilities/#get-serverinfo).

`broadcast` sends a message to connected clients on the item transport. Pass a JSON-serializable message and an optional filter to target a single user or role:

```ts
websocket.broadcast({ type: 'announcement', text: 'Deploying in 5 minutes' });
websocket.broadcast({ type: 'announcement', text: 'Admins only' }, { role: '<role-id>' });
```

`clients()` returns the set of tracked item-transport clients, for inspection or custom targeting:

```ts
const connected = websocket.clients();
```

`broadcast` and `clients` operate on the item transport. They do not reach GraphQL connections, and they throw if the item transport is not active.

`broadcast` and the service's own delivery send through a guarded path that filters by connection lifecycle and by the user and role target, enforces the outbound frame and queue bounds, and applies backpressure handling. `clients()` returns all tracked item sockets, including sockets still authenticating. A native `send` on one of them bypasses all of that, so prefer `broadcast` for delivery.

## Inbound protocol boundary

`WebSocketService` supports lifecycle observation and outbound broadcasts. The item protocol and GraphQL are the two inbound message protocols the platform serves, and an extension cannot add a third or replace their frame handling.

## Where to go next

- [Extension services](/docs/develop/extensions/server-extensions/services/) — the full service catalog available to server extensions.
- [Hooks](/docs/develop/extensions/server-extensions/hooks/) — registering actions and filters in a server extension.
- [Item protocol](/docs/api/realtime/item-protocol/) — the inbound frames observed by item-protocol message hooks.
