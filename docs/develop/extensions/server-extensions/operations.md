---
title: Operation extensions
description: Custom flow operations for the automation system.
sidebar:
  label: Operations
  order: 9
---

An operation extension adds a new step type to the [Flows](/docs/guides/flows/) system. Built-in operations cover CRUD, conditions, scripts, sleeps, email, notifications, and HTTP requests; an operation extension lets you add a step that does something specific to your project.

Operations are **hybrid extensions**, meaning they have both an app side and an API side. The app side describes how the operation appears in the flow editor (its icon, configuration form, and tile preview). The API side runs the work when a flow executes the operation.

A single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/) holds both halves.

## Anatomy

The package's source has two entrypoints: one for the app side and one for the API side. The scaffolder writes them as `app.js` and `api.js` for JavaScript projects or `app.ts` and `api.ts` for TypeScript. Both are built into `dist/app.js` and `dist/api.js`. The package's `cairncms:extension` field carries both paths and points `source` at whichever filenames the scaffolder produced:

```json
{
  "cairncms:extension": {
    "type": "operation",
    "path": { "app": "dist/app.js", "api": "dist/api.js" },
    "source": { "app": "src/app.ts", "api": "src/api.ts" },
    "host": "^1.0.0"
  }
}
```

The runtime only reads `path`; `source` is what the build CLI uses. As long as the manifest points at the right files, the source filenames themselves can be anything.

For local file installs (without packaging), use the parallel folder layout with built `.js` files:

```
<EXTENSIONS_PATH>/operations/<name>/
├── app.js
└── api.js
```

The two halves are joined by their `id`. CairnCMS recognizes them as the same operation when both export configs with matching `id` values.

## App entrypoint

The app side describes the operation's appearance in the flow editor and what fields the configuration form exposes:

```js
import { defineOperationApp } from '@cairncms/extensions-sdk';

export default defineOperationApp({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  description: 'A custom flow operation.',
  overview: ({ text }) => [
    { label: 'Text', text },
  ],
  options: [
    {
      field: 'text',
      name: 'Text',
      type: 'string',
      meta: { width: 'full', interface: 'input' },
    },
  ],
});
```

Fields available on `OperationAppConfig`:

- **`id`** — unique key. Must match the API entrypoint's `id`. Scope proprietary operations with an author or organization prefix.
- **`name`** — display name shown in the operation picker.
- **`icon`** — icon name from the Material icon set or one of CairnCMS's custom icons.
- **`description`** — short description (under 80 characters).
- **`overview`** — what shows on the operation's tile in the flow grid. Either:
  - a function `(options, { flow }) => Array<{ label, text, copyable? }>` that returns label/text pairs derived from the operation's configured options, or
  - a Vue component for fully custom rendering, or
  - `null` for no overview.
- **`options`** — fields shown in the configuration drawer when the operation is added or edited. Either an array of field definitions, a function returning an array, a Vue component for fully custom rendering, or `null` for no options.

## API entrypoint

The API side defines the work the operation actually performs:

```js
import { defineOperationApi } from '@cairncms/extensions-sdk';

export default defineOperationApi({
  id: 'custom',
  handler: ({ text }) => {
    console.log(text);
  },
});
```

Fields available on `OperationApiConfig<Options>`:

- **`id`** — unique key, matching the app entrypoint.
- **`handler`** — `(options, context) => unknown | Promise<unknown> | void` — the function that runs when the operation executes.

`defineOperationApi` is generic in the `Options` shape, which gives you typed access to the configured options inside the handler:

```ts
import { defineOperationApi } from '@cairncms/extensions-sdk';

type Options = { text: string; uppercase?: boolean };

export default defineOperationApi<Options>({
  id: 'shout',
  handler: ({ text, uppercase }) => {
    return uppercase ? text.toUpperCase() : text;
  },
});
```

## The handler

The handler runs each time a flow reaches the operation. It receives:

- **`options`** — the operation's configured options, with any data chain variables already interpolated. If the editor configured `to: '{{ $trigger.payload.email }}'`, the handler receives the resolved email address, not the template string.
- **`context`** — an object that combines the standard API extension context with two additions specific to operations:
  - `services`, `exceptions`, `database`, `env`, `logger`, `getSchema` — same as endpoint and hook contexts
  - **`data`** — the entire flow data chain, with every prior operation's output keyed by operation key
  - **`accountability`** — the accountability object derived from the flow's trigger (the originating user, role, IP, and so on)

A typical handler:

```js
import { defineOperationApi } from '@cairncms/extensions-sdk';

export default defineOperationApi({
  id: 'count-articles',
  handler: async (options, { services, accountability, getSchema, database }) => {
    const { ItemsService } = services;
    const articles = new ItemsService('articles', {
      schema: await getSchema({ database }),
      accountability,
    });

    return articles.readByQuery({
      aggregate: { count: '*' },
      filter: { status: { _eq: options.status } },
    });
  },
});
```

The result of the handler is what gets appended to the [data chain](/docs/guides/flows/#the-data-chain) under the operation's key.

## Success and failure paths

Each operation in a flow has two outgoing connectors: **success** and **failure**. The handler controls which one runs next:

- **Complete without throwing** to take the success path. Whatever the handler returns is appended to the data chain under the operation's key. A `void` or `undefined` return still resolves successfully and is stored as `null` on the data chain.
- **Throw an error** to take the failure path. The thrown value is appended to the data chain.

```js
import { defineOperationApi } from '@cairncms/extensions-sdk';

export default defineOperationApi({
  id: 'check-quota',
  handler: async ({ tenantId }, { services, exceptions, accountability, getSchema, database }) => {
    const { ItemsService } = services;
    const { ForbiddenException } = exceptions;

    const tenants = new ItemsService('tenants', {
      schema: await getSchema({ database }),
      accountability,
    });
    const tenant = await tenants.readOne(tenantId);

    if (tenant.usage >= tenant.quota) {
      throw new ForbiddenException(`Tenant ${tenantId} is over quota.`);
    }

    return { remaining: tenant.quota - tenant.usage };
  },
});
```

A `Condition` operation that follows this one can branch on either path, or you can route the failure connector to a notification operation.

## Operations vs hooks vs endpoints

Operations, hooks, and endpoints are the three server-side extension types, but each fits a different shape of work:

- **Operation** — a step inside a flow. Use this when the work belongs in a configurable, user-built pipeline.
- **Hook** — a reaction to a built-in platform event. Use this for logic that should run automatically, every time, without user configuration.
- **Endpoint** — a custom HTTP route. Use this when an external client needs a way to invoke the work directly.

The same logic is sometimes appropriate as more than one of these. For example, "send a notification when an order ships" can be a hook (filter or action on `orders.update`) or an operation (configurable step in an order-management flow). The hook is automatic; the operation is composable.

## A complete minimal example

An operation that joins two arrays of items by a shared key is useful for combining results from earlier flow operations.

`src/app.js`:

```js
import { defineOperationApp } from '@cairncms/extensions-sdk';

export default defineOperationApp({
  id: 'join-by-key',
  name: 'Join by Key',
  icon: 'merge',
  description: 'Joins two arrays from the data chain on a shared key.',
  overview: ({ leftKey, rightKey, joinOn }) => [
    { label: 'Left source', text: leftKey },
    { label: 'Right source', text: rightKey },
    { label: 'Join field', text: joinOn },
  ],
  options: [
    {
      field: 'leftKey',
      name: 'Left source key',
      type: 'string',
      meta: { width: 'half', interface: 'input' },
    },
    {
      field: 'rightKey',
      name: 'Right source key',
      type: 'string',
      meta: { width: 'half', interface: 'input' },
    },
    {
      field: 'joinOn',
      name: 'Join on field',
      type: 'string',
      meta: { width: 'full', interface: 'input' },
    },
  ],
});
```

`src/api.js`:

```js
import { defineOperationApi } from '@cairncms/extensions-sdk';

export default defineOperationApi({
  id: 'join-by-key',
  handler: ({ leftKey, rightKey, joinOn }, { data }) => {
    const left = data[leftKey] ?? [];
    const right = data[rightKey] ?? [];

    const rightByKey = new Map(right.map((row) => [row[joinOn], row]));

    return left.map((row) => ({
      ...row,
      ...(rightByKey.get(row[joinOn]) ?? {}),
    }));
  },
});
```

After build and install, the new operation appears in the operation picker. Editors configure it by selecting which two prior operation outputs to join and which field to match on.

## Confined variant

An operation runs full-authority by default. To run its server side in the sandbox, declare `runtime: confined-server` in the manifest and author the API entrypoint with `defineFlowOperation` from `@cairncms/extensions-server-api` instead of `defineOperationApi`. The app entrypoint does not change.

The handler signature changes with it. A confined handler receives `(payload, context)`, where `payload` is `{ options, input }` and `context` carries a brokered `host` instead of `services`, `database`, and the rest. Every privileged effect goes through a `host.*` call, and most return an `ExtensionResult` the handler branches on (logging is fire-and-forget):

```ts
import { defineFlowOperation } from '@cairncms/extensions-server-api';

type Options = { status: string };

export default defineFlowOperation<Options>({
  id: 'list-articles',
  async handler(payload, { host }) {
    const result = await host.items.read('articles', {
      filter: { status: { _eq: payload.options.status } },
      fields: ['id', 'title'],
      limit: 50,
    });

    if (!result.ok) {
      await host.log.warn('article read failed', { code: result.error.code });
      return { articles: [] };
    }

    return { articles: result.value };
  },
});
```

The manifest declares the runtime and the capabilities the handler uses:

```json
{
  "cairncms:extension": {
    "type": "operation",
    "path": { "app": "dist/app.js", "api": "dist/api.js" },
    "source": { "app": "src/app.ts", "api": "src/api.ts" },
    "host": "^1.0.0",
    "runtime": "confined-server",
    "capabilities": {
      "items": { "accountability": "user" },
      "log": true
    }
  }
}
```

The `items: { accountability: "user" }` mode reads as the user who triggered the flow, so the operation sees exactly what that user could read through the API. Keep the app-side options honest about the declared capabilities, and do not offer a configuration the broker would reject, such as a request method outside `request.methods`.

Secrets have two homes, by where the value belongs. A value configured per flow, such as a token the flow author pastes into the operation's options, is marked with `optionDelivery`: it is stored encrypted at rest, masked on reads, and delivered to the handler as a reference the guest never sees raw. A durable credential that belongs to the extension rather than to one flow is a [secret package setting](/docs/develop/extensions/settings/) read through `host.settings.get`. Declared operation-option secrets and inline package-setting secrets are both encrypted at rest, while a config-sourced package secret is never stored and resolves from deployment configuration.

See the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) page for the full host API, the capability vocabulary, `optionDelivery`, and the accountability modes.

## Where to go next

- [Flows](/docs/guides/flows/) covers flows from a user perspective for understanding where your operation slots in.
- [Hooks](/docs/develop/extensions/server-extensions/hooks/) and [Endpoints](/docs/develop/extensions/server-extensions/endpoints/) cover the other two server-side extension types.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full.
