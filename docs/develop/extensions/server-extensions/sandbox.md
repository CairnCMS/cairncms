---
title: Sandbox
description: The confined server runtime, its host API, capabilities, and diagnostics.
sidebar:
  label: Sandbox
  order: 20
---

:::note[The sandbox is under active development]
Its capability surface is expanding. The host API and capabilities on this page describe the current version, and not the complete, finished contract. Expect the brokered API to gain capabilities, and several of the current restrictions to lift, in future releases.
:::

The sandbox is the confined server runtime. A server extension opts into it by declaring `runtime: confined-server`, and its code then runs in a confined child process instead of the API process. The confined process has no host imports and no raw Node. Every privileged effect goes through a brokered `host.*` call that the platform gates against the capabilities and settings the extension declares.

This page is the reference for that runtime: how it runs, the boundary it enforces, how to author against it, the host API, the capability vocabulary, the build and load path, and the diagnostics. For the choice between full authority and the sandbox, see [Server extensions](/docs/develop/extensions/server-extensions/).

## How the sandbox runs

A confined extension runs in a short-lived child process, one per invocation. The API spawns a child host that loads a QuickJS engine compiled to WebAssembly, evaluates the extension's built artifact inside it, runs the handler, and returns the result.

The guest code never touches the host directly. It has no `fetch`, no filesystem, no Node builtins, and no imports from the platform. When it needs a privileged effect it calls a `host.*` method. That call is framed and sent over a dedicated channel to a broker in the API, which checks the call against the declared capabilities and settings, performs the effect, and frames a reply back. The guest sees only the reply.

Inside the engine, the guest runs under per-invocation CPU, memory, and stack limits, with the console silenced and a cap on the number of timers it can create. A run that exceeds its CPU, memory, or stack limit is terminated.

## The boundary

The boundary is the engine. A confined guest runs inside a QuickJS engine with no host imports, no Node, no `fetch`, and no filesystem, so it cannot reach the API process, the database, the environment, or the network by itself. Its only way out is a `host.*` call, and every call is checked by the broker against the capabilities and settings the extension declares. This is the sandbox: it is present in every mode and on every host, and it does not depend on the operating system. The OS hardening below is additional containment, not what makes the sandbox a sandbox.

## Defense in depth: OS hardening

A confined extension runs in its own child process, not in-process with the API. That lets the platform wrap the process in operating-system isolation, a layer an in-process sandbox cannot add. This hardening is extra containment around an already-closed boundary:

- a network namespace that severs the child's own network access,
- the Node permission model with a read scoped to the child's runtime directory,
- a cgroup memory cap.

How strictly these layers are enforced is set with the `EXTENSIONS_SANDBOX_OS_HARDENING` environment variable.

- `auto`, the default, applies each layer where the host supports it and reports where it is missing. A missing layer never blocks an extension, because the engine boundary already contains the guest.
- `required` refuses to start a confined extension unless the escape-containment core is present, that core being the network namespace and the Node permission model with its runtime-directory-scoped read. Use it on hosts where the extra isolation must be guaranteed. The cgroup memory cap is applied and reported when available but is never required.

The resolved posture for every confined extension is visible in the diagnostics.

## Authoring a confined extension

A confined extension swaps the authoring entrypoint and declares its runtime and capabilities in the manifest. The handler receives a `host` instead of reaching for platform internals.

The entrypoints come from `@cairncms/extensions-server-api`:

```ts
import { defineFlowOperation } from '@cairncms/extensions-server-api';

export default defineFlowOperation({
  id: 'my-op',
  async handler(payload, { host }) {
    const result = await host.request.send({ url: 'https://api.example.com/status' });

    if (!result.ok) {
      await host.log.warn('status request failed', { code: result.error.code });
      return { reached: false };
    }

    return { reached: true, status: result.value.status };
  },
});
```

The matching manifest declares the runtime and the capabilities the handler uses:

```json
{
  "name": "cairncms-extension-my-op",
  "cairncms:extension": {
    "type": "operation",
    "path": { "app": "dist/app.js", "api": "dist/api.js" },
    "source": { "app": "src/app.ts", "api": "src/api.ts" },
    "host": "^1.0.0",
    "runtime": "confined-server",
    "capabilities": {
      "log": true,
      "request": { "urls": ["https://api.example.com"], "methods": ["GET"] }
    }
  }
}
```

The three confined entrypoints, all from `@cairncms/extensions-server-api`:

- `defineFlowOperation({ id, handler })`. The handler is `(payload, context)`, where `payload` is `{ options, input }` and it returns the operation's output. See [Operations](/docs/develop/extensions/server-extensions/operations/).
- `defineJsonEndpoint({ id, handler })`. The handler is `(request, context)`, where `request` is `{ method, path, query, body }`, and it returns `{ status?, body }`. The handler is the whole endpoint, with no router. See [Endpoints](/docs/develop/extensions/server-extensions/endpoints/).
- `defineEventHook({ id, filters?, actions? })`. `filters` and `actions` are keyed by exact platform event name. A filter handler is `(payload, meta, context)` and returns the payload (or `undefined` for no change). An action handler is `(meta, context)` and returns nothing. See [Hooks](/docs/develop/extensions/server-extensions/hooks/).

In every case `context` is `{ extensionId, contributionId, activation, accountability, host }`. The contribution `id` must equal the extension or entry name. The load gate enforces this.

## The host API

Every privileged effect is a method on `host`. Each returns an `ExtensionResult` (except `host.log`, which is fire-and-forget), so a caller branches on the outcome rather than catching exceptions.

```ts
type ExtensionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: ExtensionHostErrorCode; message: string; details?: Record<string, unknown> } };

type ExtensionHostErrorCode =
  | 'denied'
  | 'not_found'
  | 'invalid_request'
  | 'unsupported'
  | 'timeout'
  | 'rate_limited'
  | 'internal';
```

The methods:

- `host.log.debug | info | warn | error(message, meta?)` writes a structured log line on the host. Logging is fire-and-forget and needs the `log` capability.
- `host.request.send(request)` makes an outbound HTTP request from the host and returns `ExtensionResult<{ status, headers, body }>`. The `request` is `{ url, method?, headers?, body?, timeoutMs?, auth? }`. It needs the `request` capability, and the URL's origin must be one the manifest declares.
- `host.items.readMany(collection, query?)` returns `ExtensionResult<T[]>` and `host.items.readOne(collection, key, query?)` returns `ExtensionResult<T | null>`. The `query` is `{ fields?, filter?, sort?, limit?, offset?, page?, search? }`. Both need the `items` capability. Reads are read-only in this version. `host.items.read` is a deprecated alias of `readMany`, kept for backward compatibility and removed at the next major.
- `host.settings.get(key)` returns `ExtensionResult<T | ExtensionSecretReference | null>` for a key the extension package declares in its settings. A non-secret key resolves to its stored value, a secret key resolves to an opaque secret reference for use as request auth, and an undeclared or unset key resolves to `null`. It is gated by package settings ownership and the declared key, not by a `settings` capability. Collection-scoped settings are not exposed to confined server code. See [Extension settings](/docs/develop/extensions/settings/) for the declaration.
- `host.template.renderLiquid(template, data?, options?)` renders a Liquid template on the host and returns `ExtensionResult<string>`. The `options` may set custom `delimiters`. It needs the `template` capability.

A call whose capability is not declared, or whose target is not allowed by the declared capability, comes back as `{ ok: false, error: { code: 'denied' } }` rather than throwing.

## Reading data: accountability modes

`host.items` runs under an accountability mode set by the `items` capability, `{ accountability: 'user' | 'full-access' }`. The mode is fixed per extension in the manifest and is not chosen per call. `host.items` is a generic item surface. A `directus_*` system collection or internal table cannot be the top-level collection passed to `host.items`, in either mode. Relational field paths still resolve natively, so a read of a user collection may follow a relation into a related system row, the same as a REST read. There is no confined surface for working with system collections directly. Within the surface the mode selects the accountability a read runs under: `user` applies CairnCMS role permissions, `full-access` bypasses them.

- **`{ accountability: 'user' }`** — reads run as the invoking accountability. That resolves per call to the user who ran the flow, the user whose action fired an event, or the token on an authenticated request. Field permissions apply as on a REST read, and the read fails closed. A forbidden field is a hard denial, and the primary key must be among the readable fields. A call with no accountability, such as an anonymous webhook or a schedule, is denied. Prefer this mode.
- **`{ accountability: 'full-access' }`** — reads run with elevated authority over user collections, bypassing role permissions, for user-less flows such as schedules and anonymous webhooks. It cannot pass a system or internal collection as its top-level target, per the generic-surface note above. It stays confined and read-only, and the diagnostics mark it as an elevated opt-in.

The bare `'current-user'` and `'system'` strings still load as deprecated aliases for the object form.

There is no per-flow identity. A flow runs as its trigger. For user-less work that should stay least-privilege, use a dedicated service user on an authenticated trigger and keep `{ accountability: 'user' }`.

## Capabilities

The manifest `capabilities` block is the operator-reviewable list of what the extension can reach. A capability that is not declared is denied at the broker. The vocabulary:

| Capability | Shape | Status in this version                                    |
|---|---|-----------------------------------------------------------|
| `log` | `true` | Present. Enables `host.log`.                              |
| `request` | `{ urls: string[], methods?: string[] }` | Present. Enables `host.request.send`.                     |
| `template` | `true` | Present. Enables `host.template.renderLiquid`.            |
| `items` | `{ accountability: 'user' \| 'full-access' }` | Present, read-only. Enables `host.items`.                 |
| `endpoint` | `{ access: 'public' \| 'authenticated' \| 'app' \| 'admin' }` | Present. Sets the auth gate for a confined endpoint.      |
| `files` | `{ accountability: 'user' \| 'full-access' }` | Declarable for forward compatibility, not exposed in the host API.    |
| `schema` | `('read' \| 'write')[]` | Declarable for forward compatibility, not exposed in the host API.    |

`host.settings.get` needs no capability. A confined server entry reads the settings its own package declares, gated by package ownership rather than a capability flag.

The `files` and `schema` capabilities validate and load, but the host API exposes no method for them in this version, so there is nothing to call. They are reserved for forward compatibility and operator review. Do not build on them yet.

### Request origins and methods

The `request` capability bounds outbound HTTP to a declared set.

- `urls` is a list of bare origins, each an `http://` or `https://` origin with no path, query, fragment, or credentials. At least one is required. A request is matched against the list by exact origin equality, with a case-insensitive host.
- `methods` is an optional list drawn from `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`. It defaults to `['GET']`. A request with an undeclared method is denied.

A "reach any API" design is not expressible. The operator enumerates every origin up front, and the extension can reach only those.

### Endpoint access

A confined endpoint declares `endpoint: { access: ... }`. The endpoint runner enforces the level before any child spawns.

- **`public`** — any caller.
- **`authenticated`** — a caller with a user. An anonymous caller gets 401.
- **`app`** — a user whose role grants app access. An anonymous caller gets 401, and a user without app access gets 403.
- **`admin`** — an admin user. An anonymous caller gets 401, and a non-admin user gets 403.

### Hook events

A confined hook declares the events it subscribes to in `events`, as `{ filter?: string[], action?: string[] }`, with at least one list. Each list holds up to sixteen exact platform event names. The declared events are the operator-reviewable subscription surface, and an entry whose handlers do not match its declared events fails to load. Confined hooks subscribe to filter and action events only.

### Secret operation options

An operation can mark secret option fields with `optionDelivery`, a record of `{ <optionKey>: { delivery: 'reference' } }`. A field marked this way is stored encrypted at rest, masked on external reads, and delivered to the handler as a reference the broker resolves on the host, so the secret value is never serialized into the guest. Saving a flow whose masked value is unchanged preserves the stored secret. The handler can pass the reference to `host.request.send` as `auth`, so a confined operation can call a secret-protected external API without the secret ever entering the guest.

`optionDelivery` is operation-option delivery only. Confined endpoints and hooks use [package settings](/docs/develop/extensions/settings/) for durable configuration and secret references. They do not have per-invocation operation options.

## Building and loading

A confined extension is checked twice: once when it is built, and again when the API loads it.

At build time, the confined build bundles the server entry into a single self-contained artifact that exposes the contract's global. The build runs with Node builtins not externalized, so a `node:` import or any other unresolved import fails the build rather than being left to fail at runtime. Every bundled input is then containment-checked against the package root: an input that resolves inside the package, or to a published dependency under `node_modules`, is allowed, while a `workspace:`, `file:`, or `link:` dependency that resolves to a directory outside the package is refused. So a confined build needs its dependencies installed as published `node_modules` entries, not linked from a workspace. The build output is deterministic, so the same inputs produce a byte-stable artifact.

At load time, the API re-reads the manifest under a capped read, re-checks the confined declaration and the extension's identity against the bytes it just read, resolves the declared server source set, runs a static source scan over it, and then probes the built artifact inside the sandbox to confirm the declared contract has a real binding. The gate is fail-closed: any unreadable, oversized, malformed, or contradictory input refuses, and the row is recorded as a load failure with a sanitized reason. A confined bundle probes its one shared artifact against all of its declared server entries at once, so one bad entry fails the bundle's server side.

The source scanner runs at load time, not at build time. The two checks are complementary: the build keeps host imports and stray dependencies out of the artifact, and the load gate re-verifies the manifest, scans the declared source, and proves the artifact runs before the extension is admitted.

To scaffold a confined extension, pass `--confined` to the create command. [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the command path.

## Diagnostics

The resolved state of every extension is on the Settings > Extensions page. Each row carries a health indicator: Normal, Warning when something needs attention (bundle entries that failed while others loaded, or settings that are unavailable), or Failed when the extension did not load. Opening a row shows the runtime label (Sandboxed, Full Authority, or Browser App), a sandboxed extension's declared capabilities, and the diagnostic reason behind any warning or failure. An extension that declares settings carries a Settings action in its row menu.

An Advanced Diagnostics section holds the OS-hardening posture: the resolved mode, the decision to run or refuse, which hardening layers were applied, which are missing, and the cgroup mechanic when one is used. The same diagnostics are available from the `GET /extensions` API.
