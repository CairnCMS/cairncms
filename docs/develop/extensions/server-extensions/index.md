---
title: Server extensions
description: The Node lane, code that runs in the API process either with full authority or sandboxed.
sidebar:
  label: Overview
  order: 0
---

Server extensions extend the API. They are written in JavaScript or TypeScript and run in the API's Node process. There are three types: hook, endpoint, and operation. An operation is hybrid, with a server side that runs there and an app side that renders its configuration form in the flow editor.

A server extension runs in one of two runtimes. The runtime is a per-extension choice, declared in the manifest.

## Full authority

By default, a server extension runs with full authority. It loads in the API process with full access to services, the database, and the environment, the same reach the platform's own code has. This is the default when the manifest declares no `runtime`.

Full authority is the home for what the sandbox cannot host: native modules, raw service or database access, schema changes, and the `init`, `schedule`, and `embed` hook lifecycle. A full-authority extension is unconfined, so the operator is responsible for the decision to run it, as well as the implications.

## Sandboxed

A server extension opts into the sandbox by declaring `runtime: confined-server`. The code then runs in a confined child process with no host imports and no raw Node. Every privileged effect goes through a brokered `host.*` call that the platform gates against the capabilities the extension declares, so the operator can see and bound what the extension can reach before it runs.

Endpoint handlers and operation server handlers run confined. An operation's app-side configuration form still runs in the browser, as it does for any operation. Confined hooks support filter and action events, while the `init`, `schedule`, and `embed` lifecycles stay full-authority, with no confined equivalent.

The [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) page is the full reference: the host API, the capability vocabulary, and the diagnostics.

## Which to choose

Prefer the sandbox for new server extensions when the brokered host API covers what they need. It bounds what the code can reach, makes that reach reviewable in the manifest, and keeps a faulty or compromised extension from holding the whole API process.

Reach for full authority when the sandbox cannot host the work: a native module, a raw service, a schema mutation, or a hook lifecycle the broker does not expose. Choosing full authority is choosing to run unconfined code, so weigh it as that.

## The types

- **[Hook](/docs/develop/extensions/server-extensions/hooks/)** reacts to or modifies platform events. Full-authority hooks register five functions: `filter`, `action`, `init`, `schedule`, and `embed`. Confined hooks support filters and actions.
- **[Endpoint](/docs/develop/extensions/server-extensions/endpoints/)** is a custom HTTP route mounted alongside the built-in API.
- **[Operation](/docs/develop/extensions/server-extensions/operations/)** is a custom flow operation, with a server side that runs the logic and an app side that configures it.

## Where to go next

- [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) is the confined runtime reference.
- [Internal services](/docs/develop/extensions/server-extensions/services/) is the full-authority services reference.
- The type pages above cover each server type's API, both full-authority and confined.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain: scaffold, build, install, hot reload, debug, publish.
