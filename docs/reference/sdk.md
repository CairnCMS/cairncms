---
description: The CairnCMS JavaScript SDK provides a typed, composable client for the CairnCMS REST and GraphQL APIs.
readTime: 12 min read
---

# JavaScript SDK

> `@cairncms/sdk` is a typed, composable JavaScript client for talking to a CairnCMS instance from browsers and Node.js. It uses the built-in `fetch` API (no bundled HTTP library) and supports REST, GraphQL, and authentication flows.

[[toc]]

## Installation

```bash
npm install @cairncms/sdk
```

The SDK has zero runtime dependencies and works in any environment with a global `fetch` and `URL` (modern browsers, Node.js 20+, Deno, Bun, Cloudflare Workers, etc.).

## Quick start

```ts
import { createCairnCMS, rest, readItems } from '@cairncms/sdk';

const client = createCairnCMS('http://localhost:8055').with(rest());

const articles = await client.request(readItems('articles'));
```

The SDK uses a composable pattern: `createCairnCMS(url)` returns a minimal client, and `.with(...)` attaches capabilities (REST, GraphQL, authentication). Calls are made via `client.request(command)` where `command` is a helper like `readItems`, `createItem`, etc.

## Creating a client

```ts
import { createCairnCMS } from '@cairncms/sdk';

const client = createCairnCMS('http://example.com');
```

By default, the client carries only the URL. It has no REST, GraphQL, or auth capabilities until you compose them in. This keeps the bundle size minimal for consumers who only need a subset.

### Client options

```ts
const client = createCairnCMS('http://example.com', {
  globals: {
    fetch: customFetch,
    logger: customLogger,
  },
});
```

- `globals.fetch` — override the fetch implementation (default: `globalThis.fetch`)
- `globals.URL` — override URL constructor (default: `globalThis.URL`)
- `globals.logger` — override console (default: `globalThis.console`)

Useful for: server-side rendering with a fetch polyfill, custom logging, instrumenting requests.

## Authentication

Two authentication modes are available.

### Session-based authentication (login/refresh)

```ts
import { createCairnCMS, authentication, rest } from '@cairncms/sdk';

const client = createCairnCMS('http://example.com')
  .with(authentication('json'))
  .with(rest());

await client.login('admin@example.com', 'password');
```

`authentication(mode)` accepts one of:

- `'json'` — tokens are passed in the request body. Works everywhere. Default.
- `'cookie'` — tokens are set as HTTP-only cookies by the server. Requires same-origin or configured CORS.
- `'session'` — session cookie-based, server-managed.

Choose `'json'` for cross-origin frontends (SvelteKit, Next.js on a different domain). Choose `'cookie'` or `'session'` for same-origin deployments where cookie security is preferred.

#### Login, refresh, logout

```ts
// Login returns tokens; the client automatically stores them.
const result = await client.login('email', 'password');
console.log(result.access_token, result.refresh_token);

// Refresh extends the session.
await client.refresh();

// Logout revokes the session.
await client.logout();

// Get the currently authenticated user.
import { readMe } from '@cairncms/sdk';
const me = await client.request(readMe());
```

### Static token (pre-issued)

For server-to-server calls, CI jobs, or any context where you have a long-lived token already:

```ts
import { createCairnCMS, staticToken, rest } from '@cairncms/sdk';

const client = createCairnCMS('http://example.com')
  .with(staticToken('your-token'))
  .with(rest());

const articles = await client.request(readItems('articles'));
```

Create static tokens in the admin UI (user detail page → Token field) or via the API.

## REST

```ts
import { createCairnCMS, rest, readItems } from '@cairncms/sdk';

const client = createCairnCMS('http://example.com').with(rest());
```

### Reading data

```ts
import { readItems, readItem, readSingleton, aggregate } from '@cairncms/sdk';

// List items
const articles = await client.request(
  readItems('articles', {
    fields: ['id', 'title', 'slug'],
    filter: { status: { _eq: 'published' } },
    sort: ['-date_created'],
    limit: 10,
  })
);

// Read a single item by primary key
const article = await client.request(readItem('articles', 'abc-123'));

// Read a singleton collection
const settings = await client.request(readSingleton('site_config'));

// Aggregate (count, sum, avg, min, max)
const result = await client.request(
  aggregate('articles', {
    aggregate: { count: '*' },
    groupBy: ['status'],
  })
);
```

### Writing data

```ts
import { createItem, createItems, updateItem, deleteItem } from '@cairncms/sdk';

// Create
const created = await client.request(
  createItem('articles', { title: 'Hello', status: 'draft' })
);

// Create multiple
await client.request(
  createItems('articles', [
    { title: 'One' },
    { title: 'Two' },
  ])
);

// Update
await client.request(
  updateItem('articles', created.id, { status: 'published' })
);

// Delete
await client.request(deleteItem('articles', created.id));
```

There are parallel helpers for each system collection (`createRole`, `updateUser`, `deleteFile`, etc.). See the full export list in the package, or rely on your editor's autocomplete.

### Filter DSL

Filters use the `_operator` suffix convention:

```ts
await client.request(
  readItems('articles', {
    filter: {
      _and: [
        { status: { _eq: 'published' } },
        {
          _or: [
            { date_published: { _gte: '2026-01-01' } },
            { featured: { _eq: true } },
          ],
        },
        { author: { role: { admin_access: { _eq: true } } } },
      ],
    },
  })
);
```

Scalar operators: `_eq`, `_neq`, `_gt`, `_gte`, `_lt`, `_lte`, `_in`, `_nin`, `_between`, `_nbetween`, `_null`, `_nnull`, `_empty`, `_nempty`, `_contains`, `_ncontains`, `_icontains`, `_starts_with`, `_istarts_with`, `_ends_with`, `_iends_with`.

Logical operators: `_and`, `_or` (accept arrays of filter objects).

Relational filters: traverse m2o/o2m/m2m relationships using nested object syntax (`author.role.admin_access._eq`).

### Fields syntax

The `fields` option accepts string arrays with dot notation for nested fields:

```ts
fields: [
  'id',
  'title',
  'author.first_name',
  'author.last_name',
  'tags.*',               // all fields of related tags
  'tags.*.name',          // only name on each tag
  '*',                    // all top-level scalar fields
  '*.*',                  // also one level of relations
]
```

### Pagination

```ts
await client.request(
  readItems('articles', {
    limit: 20,
    page: 3,
    // or
    offset: 40,
  })
);
```

`limit: -1` returns all rows (no limit). Use with care.

### Custom endpoints

For extension-provided routes:

```ts
import { customEndpoint } from '@cairncms/sdk';

const result = await client.request(
  customEndpoint<{ hello: string }>({
    method: 'GET',
    path: '/my-extension/hello',
  })
);
```

## GraphQL

```ts
import { createCairnCMS, graphql, authentication } from '@cairncms/sdk';

const client = createCairnCMS('http://example.com')
  .with(authentication('json'))
  .with(graphql());

await client.login('email', 'password');

const result = await client.query<{
  articles: Array<{ id: string; title: string }>;
}>(
  `query {
    articles(filter: { status: { _eq: "published" } }) {
      id
      title
    }
  }`
);
```

The GraphQL client is a thin wrapper around `POST /graphql`. The schema is auto-generated from your CairnCMS data model; retrieve it at runtime via `readGraphqlSdl()` or explore the underlying OpenAPI spec via `readOpenApiSpec()`.

### System collections via GraphQL

The `/graphql/system` endpoint exposes system collections (roles, users, permissions, etc.). Select it by passing `'system'` as the third argument to `client.query`:

```ts
const result = await client.query<{
  users: Array<{ id: string; email: string }>;
}>(
  `query { users { id email } }`,
  undefined,
  'system'
);
```

The default scope is `'items'` (the `/graphql` endpoint, which exposes user-defined collections).

## TypeScript: defining a Schema

Passing a schema type to `createCairnCMS<Schema>()` lets the SDK infer return types, validate `fields` paths, and check filter DSL correctness.

```ts
import type { DirectusUser } from '@cairncms/sdk';

type Article = {
  id: string;
  title: string;
  slug: string;
  status: 'draft' | 'published' | 'archived';
  author: DirectusUser<Schema> | string;  // allow both the expanded object and the FK
  date_created: string;
};

type Schema = {
  articles: Article[];
};

const client = createCairnCMS<Schema>('http://example.com').with(rest());

// Now the return type is known
const articles = await client.request(
  readItems('articles', { fields: ['id', 'title', 'author.first_name'] })
);
// articles is typed as Array<{ id: string; title: string; author: { first_name: string } }>
```

Relational fields should be typed as `RelatedType | string` (or `RelatedType | string | null` if nullable) so both the foreign-key string and the expanded object pass type-checking, depending on whether the field was requested in the query.

## System collection helpers

The SDK includes typed helpers for every CairnCMS system collection:

- `readUsers` / `readUser` / `createUser` / `updateUser` / `deleteUser`
- `readRoles` / `readRole` / `createRole` / `updateRole` / `deleteRole`
- `readPermissions` / `createPermission` / `updatePermission` / `deletePermission`
- `readFiles` / `importFile` / `uploadFiles` / `updateFile` / `deleteFile`
- `readFolders`, `readCollections`, `readFields`, `readRelations`, `readPresets`
- `readActivity`, `readRevisions`, `readNotifications`
- `readSettings`, `updateSettings`
- `readFlows`, `readOperations`, `readDashboards`, `readPanels`, `readShares`, `readWebhooks`
- `readFieldsByCollection`, `readRelationByCollection`, `readItemPermissions`

Plus server-level: `serverInfo`, `serverHealth`, `serverPing`, `readOpenApiSpec`, `readGraphqlSdl`.

Plus utilities: `generateHash`, `verifyHash`, `randomString`, `utilitySort`, `utilsImport`, `utilsExport`, `clearCache`, `triggerFlow`, `triggerOperation`.

## Helpers

### withToken — one-off requests with a different token

```ts
import { withToken, readItems } from '@cairncms/sdk';

const publicData = await client.request(
  withToken('different-token', readItems('articles'))
);
```

### withOptions — override fetch options per request

Wraps a request with additional `fetch` options (cache policy, credentials, abort signal, etc.):

```ts
import { withOptions, readItems } from '@cairncms/sdk';

await client.request(
  withOptions(readItems('articles'), { cache: 'no-store' })
);
```

The first argument is the command; the second is either a `Partial<RequestInit>` or a request-transformer function `(options) => options`.

### withSearch — move a GET request into a SEARCH body

When a `readItems` call has too many parameters to fit in a URL query string (large filter, long field list, etc.), `withSearch` converts the request from `GET` to `SEARCH` so the query travels in the request body instead:

```ts
import { withSearch, readItems } from '@cairncms/sdk';

await client.request(
  withSearch(
    readItems('articles', {
      fields: ['id', 'title', 'body', 'author.*'],
      filter: { /* large/complex filter */ },
      limit: 100,
    })
  )
);
```

This has nothing to do with full-text search — it's a mechanism for sending oversized query payloads.

## Compatibility

`@cairncms/sdk` is a fork of `@directus/sdk` v16.1.2 (MIT-licensed), adapted to the CairnCMS feature set and diverging from here onward.

### Not supported in v1

- **Realtime / WebSocket subscriptions** — CairnCMS v1 has no WebSocket server. The `realtime()` composable is not exported; importing it produces a type error. Revisit in a future version.
- **Translation strings CRUD** (`readTranslations`, `createTranslation`, etc.) — CairnCMS stores translation strings as a JSON blob on `directus_settings`. Read via `readSettings()` and access the `translation_strings` field. See the project roadmap for a future migration to a CRUD table.
- **Content versioning** (`readContentVersions`, `saveToContentVersion`, `promoteContentVersion`, etc.) — CairnCMS does not implement named content versions. Use the standard `status` field (`published`/`draft`/`archived`) for single-track editorial workflows.
- **Extensions CRUD** (`readExtensions`, `updateExtension`) — CairnCMS uses file-system-based extensions (`extensions/` folder, loaded at boot). There is no CRUD table. The endpoint `GET /extensions/:type` returns the list of loaded extensions for introspection; access via `customEndpoint`.

### Migrating from `@directus/sdk`

If your consumer code already uses the composable SDK API (`createDirectus(url).with(rest())`, `client.request(readItems(...))`), migration is an import rename plus a function name update. The CairnCMS SDK exposes the factory as `createCairnCMS` (and its return type as `CairnCMSClient`). Schema and command names (`readItems`, `readMe`, etc.) are unchanged.

```diff
- import { createDirectus, rest, readItems } from '@directus/sdk';
- const client = createDirectus(url).with(rest());
+ import { createCairnCMS, rest, readItems } from '@cairncms/sdk';
+ const client = createCairnCMS(url).with(rest());
```

No other code changes are required, provided you don't depend on the unsupported surfaces above.

If your consumer code uses the older class-based Directus SDK API (`new Directus(url)`, `directus.items('foo').readByQuery(...)`), you need to migrate to the composable API first. That API style was removed from `@directus/sdk` during its 10.x modernization; `@cairncms/sdk` v1 forked from that modernized version and does not include the class-based client.

### Runtime requirements

- Node.js 20.0.0 or newer
- Browsers with native `fetch` and `URL` (all modern evergreen browsers)
- The `@cairncms/sdk` package itself has zero runtime dependencies

## See also

- [Authentication reference](/reference/authentication.md) — token flows, session cookies, OAuth providers
- [Filter rules reference](/reference/filter-rules.md) — complete filter operator list
- [Query parameters reference](/reference/query.md) — `fields`, `sort`, `limit`, `meta`, `deep`
- [Items API](/reference/items.md) — the underlying REST endpoints
