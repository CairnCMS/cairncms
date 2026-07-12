---
title: Extension Settings
description: Declaring operator-managed settings in the manifest, secret values, scopes, and how server and app extension code reads them.
sidebar:
  label: Settings
  order: 2
---

Extension settings are operator-managed configuration an extension declares in its manifest. The extension declares what can be configured, and the operator supplies the values through the admin app or deployment configuration, depending on the setting. Inline values are stored by CairnCMS. Config-sourced secrets are supplied through deployment configuration instead and are never stored.

## Declaring settings

Add a `settings` block to the `cairncms:extension` manifest. Each key declares one setting. The example below is a sandboxed hook that posts a chat message when content is created: the operator supplies the chat service's API token and a sender name once, and picks a channel per collection.

```json
{
  "name": "cairncms-extension-chat-notify",
  "cairncms:extension": {
    "type": "hook",
    "path": "dist/api.js",
    "source": "src/api.ts",
    "host": "^1.0.0",
    "runtime": "confined-server",
    "capabilities": {
      "request": { "urls": ["https://chat.example.com"], "methods": ["POST"] }
    },
    "events": { "action": ["items.create"] },
    "settings": {
      "api_token": { "type": "string", "secret": { "source": "inline" }, "presentation": { "order": 1, "width": "full" } },
      "sender_name": { "type": "string", "presentation": { "order": 2, "width": "half" } },
      "notify_updates": { "type": "boolean", "presentation": { "order": 3, "width": "half" } },
      "channel": { "type": "string", "scope": "collection", "appReadable": true, "presentation": { "order": 4, "width": "full" } }
    }
  }
}
```

A settings key must start with a lowercase letter and may contain lowercase letters, digits, and underscores, up to 64 characters. The declaration must contain at least one key. Each declaration takes:

- **`type`** — `string`, `number`, or `boolean`. Required. The admin app renders a matching input, and a value of the wrong type is refused on write.
- **`scope`** — `global` or `collection`. Defaults to `global`. A global key holds one value for the whole instance. A collection key holds one value per collection, edited on each collection's data-model page.
- **`secret`** — marks the key as a secret. `{ "source": "inline" }` for a value the operator enters in the admin app, `{ "source": "config" }` for a value supplied by deployment configuration. A secret must be type `string`. See [Secret settings](#secret-settings).
- **`appReadable`** — set `true` to expose the stored value to app extension code in the browser. Defaults to unreadable. A secret can never be app-readable. See [Reading settings from app extensions](#reading-settings-from-app-extensions).
- **`presentation`** — how the field renders in the admin app: `order` sorts the fields, and `width` is `half` or `full`. Optional. `interface` selects the editing component from a platform allowlist. The only allowlisted value is `system-display-template`, the field-aware template input, valid only on a non-secret, collection-scoped string. The platform supplies the interface's context (the edited collection), never the manifest, and an id outside the allowlist or an invalid combination fails the manifest at discovery.

Field labels derive from the key name, so `sender_name` renders as "Sender Name". Pick key names that read well as labels.

Operators can only set declared keys. A write to an undeclared key is refused, and a collection-scoped write to a collection that does not exist is refused too.

## Ownership and the settings subject

The package name is the settings owner, called the subject. Stored values are keyed by it, so the name is a durable identifier, such that renaming a published package changes the subject, and values stored under the old name are left behind. They are preserved inertly and do not follow the rename.

A [bundle](/docs/develop/extensions/bundles/) declares settings once, at the package root. Every entry in the bundle shares that one declaration. There are no per-entry settings.

Settings are refused, with the reason shown in the extension's diagnostics on the Extensions page, when the subject is not usable:

- the package name is not a valid extension name,
- more than one installed extension uses the same package name,
- two packages derive the same config-secret variable (see below).

A refused subject makes settings unavailable for that extension until the conflict is resolved. It never affects whether the extension loads or runs.

## Secret settings

A secret setting never reads back raw. What that means depends on the source.

**Inline secrets** (`"secret": { "source": "inline" }`) are entered by the operator in the admin app and stored encrypted at rest. After a value is saved, every external read returns a mask, and the admin app shows a saved state rather than the value. Storing one requires the operator to configure `SECRETS_ENCRYPTION_KEY`. Without it, the save fails with a clear configuration error. See [Configuration](/docs/manage/configuration/).

**Config secrets** (`"secret": { "source": "config" }`) are never stored. The platform reads them from a deployment variable derived from the package name and key:

```
CAIRNCMS_EXT_<SANITIZED_NAME>_<KEY>
```

The name segment is the package scope (when there is one) plus the extension's local name, with the `cairncms-extension-` prefix stripped. Both segments are uppercased, runs of anything other than letters and digits become single underscores. Had the example above declared `api_token` with `"source": "config"` instead:

- `cairncms-extension-chat-notify` would read `CAIRNCMS_EXT_CHAT_NOTIFY_API_TOKEN`
- `@acme/cairncms-extension-chat-notify` would read `CAIRNCMS_EXT_ACME_CHAT_NOTIFY_API_TOKEN`

Document the variable name for your operators. It is stable and derivable ahead of deployment, so an operator can provision it through their platform's secret manager before the extension ever runs. In the admin app, a config secret surfaces only as a generic notice that the extension also uses deployment configuration. The variable name is never shown.

A config secret must be global-scoped, and a secret of either source can never be `appReadable`.

## Reading settings from a confined server entry

A sandboxed server entry reads its package's settings through `host.settings.get`. No capability is needed. The read is gated by package ownership, meaning that an extension can read only the keys its own manifest declares.

```ts
import { defineEventHook, type ExtensionSecretReference } from '@cairncms/extensions-server-api';

function isSecretReference(value: unknown): value is ExtensionSecretReference {
  return typeof value === 'object' && value !== null && (value as ExtensionSecretReference).kind === 'secret-reference';
}

export default defineEventHook({
  id: 'chat-notify',
  actions: {
    'items.create': async (_meta, { host }) => {
      const sender = await host.settings.get<string>('sender_name');
      const token = await host.settings.get('api_token');

      if (!sender.ok || !token.ok || !isSecretReference(token.value)) return;

      const from = typeof sender.value === 'string' ? sender.value : 'CairnCMS';

      await host.request.send({
        url: 'https://chat.example.com/api/messages',
        method: 'POST',
        body: { from, text: 'New content was created' },
        auth: { bearer: token.value },
      });
    },
  },
});
```

- A non-secret key resolves to its stored value, or `null` when the operator has not set one, so narrow the result before using it.
- A secret key resolves to an opaque secret reference, never the raw value, or `null` when no value is stored. Pass the reference to `host.request.send` as `auth`, and the platform injects the real value on the host side, outside the sandbox. The secret never enters the sandboxed process.
- An undeclared key resolves to `null`.
- Collection-scoped keys are not exposed to sandboxed code. `host.settings.get` reads global keys only.

See the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) reference for the host API and the secret-reference request auth.

## Reading settings from a full-authority server extension

A full-authority hook, endpoint, or operation reads its own settings through the `extensionSettings` member of its context. The reader is bound to the extension's package at registration, so there is no way to name another package's subject. The same extension built full-authority instead of sandboxed reads the same declared keys:

```js
export default ({ action }, { extensionSettings, logger }) => {
  action('items.create', async () => {
    const from = (await extensionSettings.get('sender_name')) ?? 'CairnCMS';
    const token = await extensionSettings.get('api_token');

    if (token === null) {
      logger.warn('chat-notify: no API token is configured');
      return;
    }

    await fetch('https://chat.example.com/api/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, text: 'New content was created' }),
    });
  });
};
```

- `get(key)` reads a global key. A collection-scoped key is read explicitly: `get(key, { scope: 'collection', collection: 'articles' })`.
- A non-secret key resolves to its stored value, or `null` when it is unset or mismatches its declared type.
- A secret key resolves to its raw value. An inline secret decrypts server-side, and a config secret reads its derived deployment variable. There is no brokered reference outside the sandbox.
- An undeclared key, an unavailable settings identity, a mismatched value, and an unreadable stored secret all resolve to `null`. Infrastructure failures, such as database errors, can still reject the read.

The secret handling is the difference between the runtimes. An inline secret is encrypted at rest either way, but sandboxed code receives an opaque reference the platform resolves outside the sandbox, while full-authority code receives the decrypted value, as the `Bearer ${token}` header above shows. A full-authority extension is trusted server code. The at-rest encryption protects the stored value against database exposure, not against the extension itself.

## Reading settings from app extensions

App extension code runs in the browser, so it reads settings over the API. Keys marked `appReadable: true` are served by one endpoint:

```
GET /extension-settings/app?subject=cairncms-extension-chat-notify
GET /extension-settings/app?subject=cairncms-extension-chat-notify&collection=articles
```

The response maps key to value. Global app-readable values are always included. Collection-scoped values are included only when the request names a collection and the signed-in user has read permission on it. Secrets are never served, because a secret can never be app-readable. For the example above, an app extension could read the `channel` configured for `articles`, but never `api_token`.

The endpoint requires a signed-in user with app access. Every user with app access can read the global values, so mark a key `appReadable` only when its value is safe for everyone who can open the admin app.

An [item view](/docs/develop/extensions/app-extensions/item-views/) pane does not call the endpoint directly. Its context carries a `settings` reader already bound to the owning package and the current collection.

## How operators set values

Operators edit global settings from the extension's entry on the Extensions page, and collection-scoped settings in the data model editor of each collection. Secret values are entered through a masked input that shows a saved state once stored. See [Managing extensions](/docs/guides/extensions/) for the operator walkthrough.

## Where to go next

- [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) — the confined runtime, the host API, and secret references.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) — the manifest, the toolchain, and publishing.
- [Managing extensions](/docs/guides/extensions/) — the operator side: the Extensions page, health, and editing settings.
- [Configuration](/docs/manage/configuration/) — `SECRETS_ENCRYPTION_KEY` and the deployment variables.
