---
title: Extensions
description: The extension system in CairnCMS — types, categories, and how to choose between them.
---

CairnCMS is built to be extended. The same APIs and components that power the platform are available to you, so a custom extension can add new capabilities without forking the codebase.

This page covers the extension types CairnCMS ships with and how to choose between them. The next page, [Creating extensions](/docs/develop/extensions/creating-extensions/), covers the toolchain — scaffolding, building, installing, and publishing.

## Extension types

CairnCMS supports nine extension types, grouped into four categories.

### App extensions

App extensions extend the admin app. They are written as Vue components and run in the browser.

- **[Interface](/docs/develop/extensions/interfaces/)** — a custom field editing widget. Use this to add new ways to enter or edit data on the item form.
- **[Display](/docs/develop/extensions/displays/)** — a custom read-only renderer for a field. Use this when you need a different way to show a value in lists, tables, and detail views without changing how it is edited.
- **[Layout](/docs/develop/extensions/layouts/)** — a custom collection page layout, alongside the built-in Table, Cards, Calendar, and Map.
- **[Module](/docs/develop/extensions/modules/)** — a brand-new top-level area in the module bar. Use this when you need an entire workspace that does not fit into the existing modules.
- **[Panel](/docs/develop/extensions/panels/)** — a custom panel type for Insights dashboards.

### API extensions

API extensions extend the server. They are written in JavaScript or TypeScript and run in Node.

- **[Hook](/docs/develop/extensions/hooks/)** — a way to react to or modify platform events. Hooks come in four flavours: `filter` (blocking, can transform or veto), `action` (non-blocking, runs after), `init` (runs once at startup), and `schedule` (runs on a cron schedule).
- **[Endpoint](/docs/develop/extensions/endpoints/)** — a custom HTTP route mounted alongside the built-in API. Use this when you need to expose logic that does not map to a collection's CRUD endpoints.

### Hybrid extensions

Hybrid extensions have both an app component and a server component.

- **[Operation](/docs/develop/extensions/operations/)** — a custom flow operation. The app side renders the operation's configuration form in the flow editor; the API side runs the logic when the flow executes.

### Bundle

- **[Bundle](/docs/develop/extensions/bundles/)** — a wrapper that ships several extensions of any type as a single package. Use this when several extensions share dependencies, are released together, or implement a single coherent feature across the app and API.

## Choosing an extension type

A short decision rubric:

- The user needs a new way to **edit a field's value** → Interface.
- The user needs a new way to **display a field's value** in non-edit contexts → Display.
- The user needs a new way to **browse a whole collection** → Layout.
- The user needs an **entirely new workspace** unrelated to existing modules → Module.
- A dashboard needs a new **visualization or interaction** → Panel.
- The server needs to **react to or modify a platform event** → Hook.
- The server needs to **expose a custom HTTP route** → Endpoint.
- A flow needs a **new step** → Operation.
- Several extensions ship together → Bundle.

If you find yourself wanting to ship app and server logic that should be released together, reach for a Bundle rather than separate top-level extensions.

## Convention-based customization (not extensions)

A couple of developer-facing customization paths exist outside the extension system. They use simple file-folder conventions rather than the SDK's `define*` API:

- **[Custom migrations](/docs/develop/custom-migrations/)** — drop migration `.js` files into `EXTENSIONS_PATH/migrations` and they run alongside built-in migrations.
- **[Email templates](/docs/develop/email-templates/)** — drop Liquid templates into `EXTENSIONS_PATH/templates` and reference them from the Send Email flow operation or by name from any code that sends mail.

These are not extension types and do not require the SDK or a build step. They are documented separately for that reason.

## Installation

CairnCMS discovers extensions from three sources:

- **Package extensions** — installed from npm into the project's `node_modules`. Any package whose name matches `cairncms-extension-<name>`, `@<scope>/cairncms-extension-<name>`, or `@cairncms/extension-<name>` is auto-discovered.
- **Local package extensions** — full package directories (each with its own `package.json`) placed inside `EXTENSIONS_PATH`. Bundles are installed this way.
- **Local file extensions** — pre-built extension files placed in type subfolders inside `EXTENSIONS_PATH` (for example, `EXTENSIONS_PATH/interfaces/<name>/index.js`). Used for non-bundle extension types when you do not need a separate package.

The [Creating extensions](/docs/develop/extensions/creating-extensions/) page walks through all three.

## Where to go next

- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain end to end: scaffold, build, install, hot reload, publish.
- The individual type pages above cover each extension type's API, file structure, and minimum example.
