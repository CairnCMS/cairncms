---
title: SDK
description: Reference for `@cairncms/sdk`, the official JavaScript and TypeScript client.
sidebar:
  order: 7
---

`@cairncms/sdk` is the official JavaScript client for the CairnCMS API. It works in browsers, Node, Bun, Deno, and any other runtime with a `fetch` implementation. The package is plain TypeScript and the build ships ESM and CommonJS bundles, so it imports cleanly in modern projects without configuration.

The SDK is built around composition rather than a monolithic client class. You start with a small base client and layer in the capabilities you need: REST requests, GraphQL queries, authentication, static tokens. Each capability is a "composable" that adds methods to the client. This page covers the base client, the four built-in composables, the schema-typing pattern, and the helpers that smooth over common request shapes.

## Installation

```bash
npm install @cairncms/sdk
```

The package is named `@cairncms/sdk`. Substitute `pnpm`, `yarn`, or `bun` for `npm` if you prefer.

## Creating a client

```ts
import { createCairnCMS, rest } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com').with(rest());
```

`createCairnCMS(url, options?)` returns a thin client object with three properties:

- **`url`** — the base URL parsed into a `URL` instance.
- **`globals`** — the runtime primitives the SDK uses (`fetch`, `URL`, `logger`). Override them when running in environments that need polyfills or want a custom fetch.
- **`with(composable)`** — adds a composable's methods to the client. Returns a new client with the merged shape.

The base client by itself has no request methods. You compose it with one or more of the four built-in composables (`rest`, `graphql`, `authentication`, `staticToken`) to get something useful.

## The `.with()` pattern

Composables are factory functions. Call them, then pass the result into `.with()`:

```ts
import { createCairnCMS, rest, graphql, authentication } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com')
  .with(authentication())
  .with(rest())
  .with(graphql());
```

Order matters when composables depend on each other. The `rest` and `graphql` composables look for an authentication composable's `getToken` method on the client and use it to attach `Authorization` headers. Apply `authentication` (or `staticToken`) before `rest` and `graphql` if you want automatic token attachment.

Each `.with()` returns a new merged client. The original is left untouched, so you can branch off a base client into multiple variants if a project needs them.

## REST

```ts
import { createCairnCMS, rest, readItems } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com').with(rest());

const articles = await client.request(readItems('articles', {
  filter: { status: { _eq: 'published' } },
  fields: ['id', 'title', 'author.name'],
  limit: 20,
}));
```

`rest()` adds a single method to the client: `request(command)`. The `command` argument is a value built from one of the SDK's command factories. `readItems`, `createItem`, `updateItem`, `deleteItem`, and similar functions build request descriptors that `request()` then executes. Each command corresponds to a REST endpoint and accepts the same query options as the underlying API.

The full set of commands lives under `@cairncms/sdk` as named exports. They cover every system collection (users, files, roles, permissions, settings, dashboards, panels, presets, folders, flows, operations, activity, revisions, notifications, shares), the items endpoint for user collections, server info and health, [config-as-code snapshot and apply](#config-as-code), standalone schema snapshots, and the utility endpoints under `/utils`. The TypeScript types for query parameters and return shapes are derived from the schema, so editors give accurate completions for fields and filters when a schema is provided (see [Schema typing](#schema-typing) below).

A few API surfaces deliberately have no SDK command in v1:

- **Translation strings CRUD** and the **read-only extension endpoints** (`/extensions`, inventory and the app-side loader). Use `customEndpoint`, or hit the REST endpoints directly.
- **Content versioning**. Not implemented in v1, so there is no endpoint to call.

The `rest()` composable also accepts options:

```ts
rest({
  credentials: 'include',
  onRequest: (options) => { /* mutate fetch options */ return options; },
  onResponse: (data) => { /* transform response */ return data; },
})
```

- **`credentials`** — passed straight to `fetch`. Set to `'include'` when running in a browser and using cookie-based auth across origins.
- **`onRequest`** / **`onResponse`** — global hooks invoked once per request. Useful for adding telemetry or normalizing errors across an application.

Per-request hooks are also available on individual commands via [helpers](#helpers).

## Config-as-code

Use `configSnapshot` and `configApply` to deploy a reviewed [config-as-code document](/docs/manage/config-as-code/) from JavaScript or TypeScript. Both commands require an authenticated administrator and CairnCMS server 1.7.0 or later. Use SDK 1.7.0 or later for these commands.

Make changes on the source instance, capture its desired state, then preview it on the target. The examples below assume `source` and `target` are authenticated SDK clients with `rest()`. Keep deployment credentials in your script's secret store, not in browser code.

```ts
import { configApply, configSnapshot } from '@cairncms/sdk';

const desired = await source.request(configSnapshot({
  resources: ['schema', 'folders'],
}));

const plan = await target.request(configApply(desired, { dryRun: true }));
console.log(plan.summary);
```

This captures schema and folders only. Choose the [managed resources](/docs/manage/config-as-code/scope-and-deletions/) before capturing. Review `plan.changes`, `plan.warnings` and `plan.protections` before applying.

### Snapshot options

`configSnapshot({ manifestVersion?, resources? })` returns the document directly.

- `manifestVersion` selects format `1`, `2` or `3`. The default is `3`. TypeScript returns the corresponding `ConfigDocumentV1`, `ConfigDocumentV2` or `ConfigDocumentV3` when the version is known, or their `ConfigDocument` union for a runtime-selected version.
- `resources` selects the kinds to manage. Omit it to capture all kinds supported by that manifest version. An empty array, `resources: []`, manages none.

### Apply the reviewed document

Back up the target and follow the [deployment guidance](/docs/manage/config-as-code/deployments/) before applying. Send the same captured document, not the dry-run plan:

```ts
const outcome = await target.request(configApply(desired));
console.log(outcome.meta.result, outcome.meta.steps);
```

This sends one apply request. `configApply(document, options?)` accepts:

- `dryRun: true` returns a `ConfigPlanOutput` without writing. Deletions can be previewed without `destructive`.
- `destructive: true` authorizes intended deletions when applying. Leave it unset unless you have reviewed those deletions.
- `forceSchema: true` waives the schema source release and database vendor checks, including during a dry run. It does not make an incompatible schema safe or bypass other validation.

Without `dryRun`, the result is a `ConfigApplyOutput` with `{ data, meta }`. `meta.result` is `applied` or `no_changes`. `meta.steps` reports the `folders`, `schema` and `configuration` outcomes. Use these fields to determine what the request did.

`data` contains the configuration step's result. It can be null even when schema changes were applied. See [success envelopes](/docs/manage/config-as-code/http-api/#success-envelopes) for the full result shape.

API errors reject with `{ errors, response }`. Each error retains `extensions.code` and, when provided by the server, `extensions.steps` and `extensions.failure`. An apply can fail after making changes. Follow [Failure recovery](/docs/manage/config-as-code/recovery/) before retrying a failed request or one whose response was lost.

:::caution[Schema diff and apply SDK commands are deprecated]
`schemaDiff` and `schemaApply` are deprecated in 1.7.0. Capture schema with `configSnapshot` and preview or apply it with `configApply` instead. `schemaSnapshot()` remains supported. See the [changelog](https://github.com/CairnCMS/cairncms/blob/main/CHANGELOG.md) for removal timing.
:::

## GraphQL

```ts
import { createCairnCMS, graphql } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com').with(graphql());

const result = await client.query<{ articles: Article[] }>(`
  query {
    articles(limit: 5) {
      id
      title
    }
  }
`);
```

`graphql()` adds a `query<Output>(query, variables?, scope?)` method to the client. The `scope` argument selects between the two GraphQL endpoints:

- **`'items'`** (default) — posts to `/graphql`, the user-collection endpoint.
- **`'system'`** — posts to `/graphql/system`, the system-collection endpoint with the auth and TFA mutations.

The same authentication composable works for GraphQL and REST. Compose `authentication()` (or `staticToken()`) before `graphql()` to get automatic `Authorization` header attachment on every query.

## Realtime

The `realtime()` composable adds a WebSocket client for subscribing to collection changes: `connect`, `subscribe`, `disconnect`, and an async-generator message stream. It supports the `public` and `handshake` authentication modes. See [Realtime SDK](/docs/api/realtime/sdk/) for setup, the subscription stream, configuration, and the type-safe delete feed, and the [Realtime](/docs/api/realtime/) section for the underlying protocol.

## Authentication

The `authentication` composable handles the JWT login flow: login, automatic refresh, logout, and token storage. It is the right choice for interactive sessions where users sign in and the SDK manages the access and refresh tokens for the duration of the session.

```ts
import { createCairnCMS, authentication, rest } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com')
  .with(authentication('json'))
  .with(rest());

await client.login('user@example.com', '<password>');

const me = await client.request(readMe());
```

`authentication(mode, config?)` accepts:

- **`mode`** — `'cookie'` (default) or `'json'`. Controls whether the refresh token is stored in an HTTP-only cookie or in the SDK's storage. Use `'json'` for non-browser environments and any browser context where you cannot rely on cookies. Use `'cookie'` for first-party browser apps where the refresh token is best kept out of JavaScript-readable storage.
- **`config.storage`** — a custom storage implementation. The default is in-memory. Override for browser apps that need to persist tokens across reloads (using `localStorage`, `sessionStorage`, IndexedDB, or anything else that implements the storage interface).
- **`config.autoRefresh`** — `true` (default) to schedule automatic token refresh before expiry. Set to `false` to manage refresh manually.
- **`config.msRefreshBeforeExpires`** — milliseconds before token expiry to trigger a refresh. Default `30000` (30 seconds).
- **`config.credentials`** — passed to `fetch` for auth requests. Set to `'include'` for cookie-mode auth across origins.

The composable adds these methods to the client:

- **`login(email, password, options?)`** — exchange credentials for tokens. Options include `otp` (for TFA-enabled accounts), `mode` (overrides the composable's mode), and `provider`. The `provider` option only switches the request path to `/auth/login/<provider>` for credential-style providers like LDAP or any custom local-style driver. It does not handle browser-redirect flows (OAuth2, OpenID Connect, SAML), which require a redirect through the identity provider that the SDK does not orchestrate. Use the REST endpoints directly for those, then call `setToken()` with the resulting access token.
- **`refresh()`** — manually trigger a refresh. Auto-refresh handles this in the background, so explicit calls are rare.
- **`logout()`** — invalidate the refresh token and clear stored credentials.
- **`getToken()`** — returns the current access token, refreshing first if it is about to expire. This is the method that `rest()` and `graphql()` call internally to attach the `Authorization` header.
- **`setToken(access_token)`** — set the access token directly. Useful for resuming a session from an externally-stored token.
- **`stopRefreshing()`** — cancel the auto-refresh timer. Useful for cleanup on logout or when tearing down a long-running process.

## Static tokens

For service accounts and CI scripts, the static-token composable is simpler than the auth flow:

```ts
import { createCairnCMS, staticToken, rest } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com')
  .with(staticToken(process.env.CAIRNCMS_TOKEN))
  .with(rest());

const result = await client.request(readItems('articles'));
```

`staticToken(token)` adds `getToken()` and `setToken()` methods that return the configured token. The `rest()` and `graphql()` composables then attach it as `Authorization: Bearer <token>` on every request. There is no refresh flow because static tokens do not expire.

Use `authentication()` for users; use `staticToken()` for machines.

## Schema typing

For type safety across collection names, fields, and query results, pass a `Schema` type parameter to `createCairnCMS`:

```ts
import { createCairnCMS, rest, readItems } from '@cairncms/sdk';

interface Schema {
  articles: Article;
  authors: Author;
}

interface Article {
  id: number;
  title: string;
  author: number | Author;
  status: 'draft' | 'review' | 'published';
}

interface Author {
  id: number;
  name: string;
}

const client = createCairnCMS<Schema>('https://cms.example.com').with(rest());

const articles = await client.request(readItems('articles', {
  fields: ['id', 'title', 'author.name'],
}));
// articles is typed: id: number, title: string, author: { name: string }
```

The `Schema` type maps collection names to their record types. The SDK uses it to validate collection names at compile time and to derive return shapes from the `fields` option, including dotted paths for relations. When `fields` includes a relation path, the corresponding nested type appears in the result.

For projects with many collections, a build-time generator can read `GET /schema/snapshot` through the SDK's `schemaSnapshot()` helper and produce TypeScript interfaces. Both remain supported. The SDK ships no generator of its own.

For deployment, use the [config-as-code commands](#config-as-code), `configSnapshot` and `configApply`.

When `Schema` is omitted, the client falls back to `any` for collection records. The runtime behavior is identical; only the editor-time type checking changes.

## Helpers

The SDK exposes a few helpers for shaping requests beyond what the command catalog covers directly.

### `withToken`

Override the token for a single request without affecting the composable's stored token:

```ts
import { withToken, readItems } from '@cairncms/sdk';

await client.request(withToken('<other-token>', readItems('articles')));
```

Useful when a script runs as one user but needs to perform a single action as another (for example, a CI job that uses an admin token but issues a single request as the user being onboarded).

### `withSearch`

Convert a `GET` command to a `SEARCH` request, with the query options moved into the request body:

```ts
import { withSearch, readItems } from '@cairncms/sdk';

await client.request(withSearch(readItems('articles', {
  filter: /* a deeply-nested filter that would overflow the URL */,
  fields: ['*', 'author.*'],
})));
```

Reach for this when a query is large enough to bump up against URL length limits. See [SEARCH method](/docs/api/introduction/#the-search-method) for the underlying mechanism.

### `customEndpoint`

Build a request against a custom endpoint that does not have a corresponding SDK command:

```ts
import { customEndpoint } from '@cairncms/sdk';

const result = await client.request(customEndpoint<MyResponse>({
  path: '/my-extension/endpoint',
  method: 'POST',
  body: JSON.stringify({ /* ... */ }),
}));
```

Useful for endpoints exposed by [custom extensions](/docs/develop/extensions/server-extensions/endpoints/) where a typed command does not exist.

By default, the SDK returns a JSON response's `data` field. Set `envelope: true` in the `customEndpoint` options to receive the whole JSON body, including fields such as `meta`. This returns the parsed body, not a raw `Response`, and leaves error handling unchanged. Set the `MyResponse` type to match that whole body when opting in.

### `withOptions`

Per-request overrides for fetch options on a command:

```ts
import { withOptions, readItems } from '@cairncms/sdk';

await client.request(withOptions(readItems('articles'), {
  signal: abortController.signal,
  cache: 'no-store',
}));
```

Useful for cancellation through `AbortController`, per-request cache directives, or anything else that needs `fetch` options without a global hook.

## Globals

The base client uses three runtime primitives, exposed under `client.globals`:

- **`fetch`** — defaults to `globalThis.fetch`. Override for environments that need a polyfill (older Node versions, Deno with custom permissions) or a custom implementation (instrumentation, retry logic).
- **`URL`** — defaults to `globalThis.URL`. Override only in environments where the global is missing.
- **`logger`** — defaults to `globalThis.console`. Override to capture SDK warnings in your application's logging system.

Pass overrides through the second argument to `createCairnCMS`:

```ts
import { createCairnCMS } from '@cairncms/sdk';
import nodeFetch from 'node-fetch';

const client = createCairnCMS('https://cms.example.com', {
  globals: { fetch: nodeFetch as unknown as typeof fetch },
});
```

In modern runtimes (Node 22+, Bun, Deno, all evergreen browsers), the defaults work without configuration.

## Where to go next

- [Authentication](/docs/api/authentication/) — the underlying auth endpoints, SSO providers, and TFA flow that the `authentication` composable uses.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL that command options accept.
- [Items](/docs/api/items/) — the REST endpoints `readItems`, `createItem`, etc. wrap.
- [GraphQL](/docs/api/graphql/) — the underlying GraphQL endpoints the `graphql` composable posts to.
