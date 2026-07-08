---
title: Extensions
description: The extension system in CairnCMS, its types, the three runtimes they run in, and how to choose between them.
sidebar:
  label: Overview
  order: 0
---

CairnCMS is built to be extended. The same APIs and components that power the platform are available to you, so a custom extension can add new capabilities without forking the codebase.

This page covers the extension types CairnCMS ships with, the three runtimes they run in, and how to choose between them. The next page, [Creating extensions](/docs/develop/extensions/creating-extensions/), covers the toolchain: scaffolding, building, installing, and publishing.

## How extensions run

Before you pick a type, it helps to know where your code runs. CairnCMS has three runtimes, and the runtime decides what your code can reach.

- **In the browser.** App extensions (interface, display, layout, module, panel) are Vue components that run in the admin app, inside the logged-in user's browser. They act through the API with that user's own permissions, and can do whatever that user can do, no more and no less. The browser is not a security boundary. See [App extensions](/docs/develop/extensions/app-extensions/).
- **In the API, with full authority.** A server extension (hook, endpoint, operation) runs in the API's Node process. By default it has full access to services, the database, and the environment. This is the home for code that needs native modules, raw services, or schema changes. It is the default when a server extension declares no runtime.
- **In the API, sandboxed.** The same server types can opt into the confined runtime by declaring `runtime: confined-server`. The code then runs in a sandboxed child with no host imports and no raw Node. Every privileged effect goes through a brokered `host.*` call that the platform gates against the capabilities and settings the extension declares. See [Sandbox](/docs/develop/extensions/server-extensions/sandbox/).

A server extension is full-authority unless it opts into the sandbox. Prefer the sandbox for new server extensions when the brokered API covers what they need, and reach for full authority only for what the sandbox cannot host. [Server extensions](/docs/develop/extensions/server-extensions/) covers the choice in full.

## Extension types

CairnCMS supports nine extension types in three groups.

### App extensions

Vue components that run in the admin browser. See [App extensions](/docs/develop/extensions/app-extensions/) for the lane.

- **[Interface](/docs/develop/extensions/app-extensions/interfaces/)** is a custom field editing widget. Use this to add new ways to enter or edit data on the item form.
- **[Display](/docs/develop/extensions/app-extensions/displays/)** is a custom read-only renderer for a field. Use this when you need a different way to show a value in lists, tables, and detail views without changing how it is edited.
- **[Layout](/docs/develop/extensions/app-extensions/layouts/)** is a custom collection page layout, alongside the built-in Table, Cards, Calendar, Map, and Kanban.
- **[Module](/docs/develop/extensions/app-extensions/modules/)** is a top-level area in the module bar. Use this when you need an entire workspace that does not fit into the existing modules.
- **[Panel](/docs/develop/extensions/app-extensions/panels/)** is a custom panel type for Insights dashboards.

### Server extensions

Code that runs in the API in Node, either full-authority or sandboxed. See [Server extensions](/docs/develop/extensions/server-extensions/) for the lane.

- **[Hook](/docs/develop/extensions/server-extensions/hooks/)** reacts to or modifies platform events. Full-authority hooks come in five types: `filter` (blocking, can transform or veto), `action` (non-blocking, runs after), `init` (runs once at startup), `schedule` (runs on a cron schedule), and `embed` (injects HTML into the admin app's head or body). Sandboxed hooks support filters and actions.
- **[Endpoint](/docs/develop/extensions/server-extensions/endpoints/)** is a custom HTTP route mounted alongside the built-in API. Use this when you need to expose logic that does not map to a collection's CRUD endpoints.
- **[Operation](/docs/develop/extensions/server-extensions/operations/)** is a custom flow operation. It is hybrid: the app side renders the operation's configuration form in the flow editor, and the server side runs the logic when the flow executes. The server side is what chooses full authority or the sandbox.

### Bundle

- **[Bundle](/docs/develop/extensions/bundles/)** is a wrapper that ships multiple, mixed extensions as a single package. Use this when several extensions share dependencies, are released together, or implement a single coherent feature across the app and server. A bundle spans both groups.

## Choosing an extension type

A short decision rubric:

- The user needs a new way to **edit a field's value**, use an Interface.
- The user needs a new way to **display a field's value** in non-edit contexts, use a Display.
- The user needs a new way to **browse a whole collection**, use a Layout.
- The user needs an **entirely new workspace** unrelated to existing modules, use a Module.
- A dashboard needs a new **visualization or interaction**, use a Panel.
- The server needs to **react to or modify a platform event**, use a Hook.
- The server needs to **expose a custom HTTP route**, use an Endpoint.
- A flow needs a **new step**, use an Operation.
- Several extensions ship together, use a Bundle.

If you find yourself wanting to ship app and server logic that should be released together, reach for a Bundle rather than separate top-level extensions.

## Convention-based customization (not extensions)

A couple of developer-facing customization paths exist outside the extension system. They use simple file-folder conventions rather than the SDK's `define*` API:

- **[Custom migrations](/docs/develop/custom-migrations/)** let you drop migration `.js` files into `EXTENSIONS_PATH/migrations` and they run alongside built-in migrations.
- **[Email templates](/docs/develop/email-templates/)** let you drop Liquid templates into `EXTENSIONS_PATH/templates` and reference them from the Send Email flow operation or by name from any code that sends mail.

These are not extension types and do not require the SDK or a build step. They are documented separately for that reason.

## Installation

CairnCMS discovers extensions from three sources:

- **Package extensions** are installed from npm into the project's `node_modules`. Any package whose name matches `cairncms-extension-<name>`, `@<scope>/cairncms-extension-<name>`, or `@cairncms/extension-<name>` is auto-discovered.
- **Local package extensions** are full package directories (each with its own `package.json`) placed inside `EXTENSIONS_PATH`. Bundles are installed this way.
- **Local file extensions** are pre-built extension files placed in type subfolders inside `EXTENSIONS_PATH` (for example, `EXTENSIONS_PATH/interfaces/<name>/index.js`). Used for non-bundle extension types when you do not need a separate package.

The [Creating extensions](/docs/develop/extensions/creating-extensions/) page walks through all three.

## Where to go next

- [App extensions](/docs/develop/extensions/app-extensions/) covers the browser lane and links to each app type.
- [Server extensions](/docs/develop/extensions/server-extensions/) covers the Node lane and the full-authority versus sandboxed choice.
- [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) is the reference for the confined runtime: the host API, capabilities, and diagnostics.
- [Extension settings](/docs/develop/extensions/settings/) covers declaring operator-managed settings and secrets, and how sandboxed server entries and app extensions read them.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain end to end: scaffold, build, install, hot reload, debug, publish.
