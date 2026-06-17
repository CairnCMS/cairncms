# @cairncms/extensions-server-api

The authoring API for sandboxed (confined) CairnCMS server extensions. It provides the `define*` entrypoints for confined flow operations, JSON endpoints, and event hooks, plus the types for the brokered `host.*` API the platform passes to every handler.

## Install

The scaffolder adds this package for you when you create a confined server extension:

```sh
npm init cairncms-extension
```

To add it to an existing project:

```sh
npm install --save-dev @cairncms/extensions-server-api
```

The confined build bundles this package away as an identity helper, so it is a development dependency, not a runtime one.

## Usage

A confined server extension exports a contribution defined with one of the `define*` helpers. The handler receives a `host` and never imports platform internals:

```ts
import { defineFlowOperation } from '@cairncms/extensions-server-api';

export default defineFlowOperation({
  id: 'my-op',
  async handler(payload, { host }) {
    const result = await host.request.send({ url: 'https://api.example.com/status' });

    if (!result.ok) return { reached: false };

    return { reached: true, status: result.value.status };
  },
});
```

The three entrypoints:

- `defineFlowOperation` for a flow operation.
- `defineJsonEndpoint` for an HTTP endpoint, where the handler is the whole endpoint and returns `{ status?, body }`.
- `defineEventHook` for filter and action event hooks.

Every privileged effect goes through the brokered `host.*` API (`host.log`, `host.request`, `host.items`, `host.settings`, `host.template`), gated by the capabilities the extension declares in its manifest. Most of these calls return an `ExtensionResult` envelope, so a handler branches on the outcome rather than catching exceptions. Logging is fire-and-forget and resolves to nothing.

For the full host API, the capability vocabulary, and the runtime model, see the [Sandbox documentation](https://cairncms.dev/docs/develop/extensions/server-extensions/sandbox/).

## License

[MIT](./LICENSE).
