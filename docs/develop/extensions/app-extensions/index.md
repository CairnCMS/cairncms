---
title: App extensions
description: The browser lane, Vue components that run in the admin app under the logged-in user's permissions.
sidebar:
  label: Overview
  order: 0
---

App extensions extend the admin app. They are written as Vue components and run in the browser, in the same page as the rest of the admin app. There are five types: interface, display, layout, module, and panel.

## How app extensions run

An app extension runs inside the logged-in user's browser session. When it reads or writes data, it calls the API as that user, so it can do whatever that user can do through the API, and no more. The browser is not a security boundary: the code, the admin app, and the user's session all share the same page. An app extension is as capable as the person running it.

That makes the app lane the wrong place for anything that must hold regardless of who is signed in. Logic that has to be enforced, secrets that must not reach the browser, and access beyond the current user's permissions belong on the server. See [Server extensions](/docs/develop/extensions/server-extensions/), and the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) when that server code should be confined.

## Browser egress

Because an app extension runs in the browser, its outbound network requests go through the admin app's Content Security Policy. The default policy limits `connect-src` to the app's own origin plus the built-in map origins, with no external wildcard, so an app extension that tries to fetch an external API or CDN directly from the browser is blocked.

To use external data, route it through a same-origin endpoint instead. A confined server endpoint, or a bundle's endpoint entry, fetches the external API server-side, and your app extension calls that endpoint on its own origin. This keeps the browser egress and the declared external origins on the server. When the external API needs a credential, declare it as a [secret package setting](/docs/develop/extensions/settings/): the endpoint reads it through `host.settings.get` as an opaque reference and the platform injects the value outside the sandbox, so the secret reaches neither the browser nor the sandboxed code. An operator can widen the policy with `CONTENT_SECURITY_POLICY_DIRECTIVES__CONNECT_SRC` when a specific external origin must be reachable from the browser, but the same-origin endpoint is the default pattern. See [Security hardening](/docs/manage/security-hardening/) for the operator side.

## The Vue baseline

App extensions share the admin app's Vue runtime rather than bundling their own. The host Vue is the floor an app extension builds against, and `vue` is a shared dependency, so an extension binds to the host's version at build time.

The practical consequence: when the host Vue or the SDK changes, rebuild the extension. A `dist` built against an older toolchain can fail to mount against a newer host runtime. Building against the current SDK keeps the artifact aligned with the host.

## The types

- **[Interface](/docs/develop/extensions/app-extensions/interfaces/)** is a custom field editing widget. Use this to add new ways to enter or edit data on the item form.
- **[Display](/docs/develop/extensions/app-extensions/displays/)** is a custom read-only renderer for a field. Use this for a different way to show a value in lists, tables, and detail views without changing how it is edited.
- **[Layout](/docs/develop/extensions/app-extensions/layouts/)** is a custom collection page layout, alongside the built-in Table, Cards, Calendar, Map, and Kanban.
- **[Module](/docs/develop/extensions/app-extensions/modules/)** is a top-level area in the module bar. Use this when you need an entire workspace that does not fit into the existing modules.
- **[Panel](/docs/develop/extensions/app-extensions/panels/)** is a custom panel type for Insights dashboards.

## Where to go next

- The type pages above cover each app type's API, file structure, and a minimal example.
- [Composables](/docs/develop/extensions/app-extensions/composables/) covers the SDK composables for data and stores. [UI components](/docs/develop/extensions/app-extensions/ui-components/) covers the component library and theme tokens.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain: scaffold, build, install, hot reload, debug, publish.
