---
title: Clients
description: How to consume the CairnCMS API from another application — authentication, querying, mutations, file uploads, and the official SDK.
sidebar:
  order: 1
---

CairnCMS is API-first. Once a collection is in place, every record is reachable through REST and GraphQL endpoints generated from the current schema and permission model. This page covers the durable patterns for consuming those APIs from another application such as a frontend, a backend service, a script, a mobile app, or anything else that speaks HTTP.

CairnCMS does not prescribe a frontend framework or runtime. Anything that can make HTTP requests can be a client.

## Choosing an interface

There are three ways to talk to CairnCMS:

- **REST** — the standard set of endpoints under `/items/<collection>`, `/files`, `/users`, and so on. Available everywhere; works with any HTTP client.
- **GraphQL** — a single `/graphql` endpoint for queries and mutations. Useful when a client wants to fetch deeply nested data in one round trip.
- **JavaScript SDK** — the `@cairncms/sdk` package wraps both REST and GraphQL with a typed, composable client. Best choice for JavaScript and TypeScript clients.

REST and GraphQL are interfaces over the same underlying services. They are not separate data paths. Permissions, validation, and event hooks all apply identically.

## The JavaScript SDK

The SDK is the recommended path for JavaScript and TypeScript clients. It is composable, typed, and uses the built-in `fetch` API with no runtime dependencies.

Install:

```bash
npm install @cairncms/sdk
```

Compose only what you need. A REST-only client without authentication:

```ts
import { createCairnCMS, rest, readItems } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com').with(rest());

const articles = await client.request(readItems('articles'));
```

A client with login, refresh, and REST:

```ts
import { createCairnCMS, rest, authentication, readMe } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com')
  .with(authentication('json'))
  .with(rest());

await client.login('admin@example.com', 'password');

const me = await client.request(readMe());
```

A client using a static token (no login flow):

```ts
import { createCairnCMS, rest, staticToken, readItems } from '@cairncms/sdk';

const client = createCairnCMS('https://cms.example.com')
  .with(staticToken('long-lived-token'))
  .with(rest());

const products = await client.request(readItems('products'));
```

The full SDK reference, including every command (`readItems`, `createItem`, `updateItem`, `uploadFiles`, and so on), schema typing, and the filter DSL, is on the SDK API reference page.

### What the v1 SDK does not include

A few features from upstream Directus are deliberately not part of the v1 CairnCMS SDK:

- **realtime / WebSocket subscriptions** (`realtime()`) — the WebSocket endpoint exists; clients can connect directly
- **translation strings CRUD** — translation strings are stored on `directus_settings` (the `translation_strings` field); manage them by reading and patching that record
- **content versioning** — not implemented in CairnCMS v1 at all; no API surface to call
- **extensions CRUD** — the `/extensions` endpoints exist; call them directly via REST

Three of these have a working endpoint that the SDK simply does not wrap. Content versioning is the exception: it is genuinely absent in CairnCMS v1.

## Authentication

Three authentication paths cover almost all client cases.

### Password login

For interactive clients where users enter a password.

REST:

```bash
curl -X POST https://cms.example.com/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"user@example.com","password":"hunter2","mode":"json"}'
```

The response contains an `access_token` (short-lived) and, in `mode: "json"`, a `refresh_token`. In `mode: "cookie"` (the default), the refresh token is set as an `httpOnly` cookie instead. The access token is sent on subsequent requests as `Authorization: Bearer <token>`.

When the access token expires, exchange the refresh token for a new pair at `POST /auth/refresh`.

SDK:

```ts
const client = createCairnCMS(url)
  .with(authentication('json'))
  .with(rest());

await client.login('user@example.com', 'hunter2');
// later, the SDK refreshes automatically when the access token nears expiry
await client.logout();
```

The SDK's `authentication('cookie')` mode delivers the refresh token as a cookie which is appropriate when CairnCMS and the client share a parent domain. `authentication('json')` keeps the refresh token in memory or wherever you choose to store it, which is appropriate for non-browser clients and cross-origin clients that would otherwise need permissive cookie settings.

### Static tokens

For service accounts, scripts, and integrations that authenticate non-interactively. A static token is generated on a user record under **User Directory** in the app and stays valid until you regenerate or clear it. Static tokens carry the role and permissions of the user they belong to.

REST:

```bash
curl https://cms.example.com/items/articles \
  -H 'Authorization: Bearer <token>'
```

SDK:

```ts
const client = createCairnCMS(url).with(staticToken('<token>')).with(rest());
```

Static tokens are not refreshed and have no expiry. Treat them like passwords. Store them as secrets, not in source control.

### Single sign-on

For SSO providers such as Google, Okta, or a SAML IdP, the user is redirected to a CairnCMS-hosted URL that delegates to the provider and redirects back. SDKs cannot perform the OAuth dance for you; the client opens a browser tab and consumes the resulting session cookie or refresh token.

See the [Auth](/docs/guides/auth/) guide for the full SSO configuration, including cross-domain SSO for headless clients.

## Querying items

The basic query endpoint is `GET /items/<collection>`. The same query parameters work in REST, GraphQL (as arguments), and the SDK (as the second argument to `readItems`):

- **`fields`** — which fields to return; supports dot notation for relations and `*` for all fields
- **`filter`** — a filter rule object (see Filters below)
- **`sort`** — comma-separated field names; prefix with `-` for descending
- **`limit`** / **`offset`** / **`page`** — pagination
- **`search`** — full-text search across string fields
- **`deep`** — apply nested queries to relational fields
- **`aggregate`** — count, sum, average, min, max
- **`groupBy`** — group results by one or more fields

REST:

```bash
curl "https://cms.example.com/items/articles?fields=id,title,author.name&filter[status][_eq]=published&sort=-date_published&limit=10"
```

SDK:

```ts
const articles = await client.request(
  readItems('articles', {
    fields: ['id', 'title', 'author.name'],
    filter: { status: { _eq: 'published' } },
    sort: ['-date_published'],
    limit: 10,
  })
);
```

GraphQL:

```graphql
query {
  articles(
    filter: { status: { _eq: "published" } }
    sort: ["-date_published"]
    limit: 10
  ) {
    id
    title
    author {
      name
    }
  }
}
```

For the filter operator reference (`_eq`, `_in`, `_contains`, `_lt`, dynamic variables like `$CURRENT_USER`, and so on), see the API reference.

## Mutating items

Create, update, and delete work the same way through all three interfaces.

REST:

```bash
# Create
curl -X POST https://cms.example.com/items/articles \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"title":"New post","status":"draft"}'

# Update
curl -X PATCH https://cms.example.com/items/articles/42 \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"status":"published"}'

# Delete
curl -X DELETE https://cms.example.com/items/articles/42 \
  -H 'Authorization: Bearer <token>'
```

SDK:

```ts
import { createItem, updateItem, deleteItem } from '@cairncms/sdk';

await client.request(createItem('articles', { title: 'New post', status: 'draft' }));
await client.request(updateItem('articles', 42, { status: 'published' }));
await client.request(deleteItem('articles', 42));
```

Bulk variants (`createItems`, `updateItems`, `deleteItems`) take arrays.

Mutations respect the same permissions as the user or token making the request. A custom-permissions filter rule (for example, "only update items where `owner = $CURRENT_USER`") is applied automatically.

## File upload

Files arrive in CairnCMS through two endpoints:

- **`POST /files`** — accepts multipart form data; uploads file bytes from a browser or HTTP client
- **`POST /files/import`** — accepts a JSON body of `{ url, data }`; imports the file from a remote URL

These are separate endpoints, not two modes of the same one.

REST (upload):

```bash
curl -X POST https://cms.example.com/files \
  -H 'Authorization: Bearer <token>' \
  -F 'title=Cover image' \
  -F 'file=@./cover.jpg'
```

REST (import from URL):

```bash
curl -X POST https://cms.example.com/files/import \
  -H 'Authorization: Bearer <token>' -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/image.jpg","data":{"title":"From URL"}}'
```

SDK:

```ts
import { uploadFiles, importFile } from '@cairncms/sdk';

// Upload
const formData = new FormData();
formData.append('title', 'Cover image');
formData.append('file', file); // a File or Blob
const uploaded = await client.request(uploadFiles(formData));

// Import from URL
const imported = await client.request(
  importFile('https://example.com/image.jpg', { title: 'From URL' })
);
```

The response in either case is the new file record, including the `id` you can reference from collection records via a File or Image relation field.

For the storage backend each file lands on, and how file relations behave, see the [Files](/docs/guides/files/) guide.

## Public access

Unauthenticated requests run with the **Public** role's permissions. By default, the Public role has no permissions, so an unauthenticated request to any endpoint returns either an empty result or a forbidden error.

To allow public reads of a collection, grant the Public role read access on that collection under **Settings > Roles & Permissions**. To restrict which fields are visible publicly, use the Public role's field permissions. To filter which records are public, use a custom-permissions filter rule.

A public-by-default API is generally not what you want. Configure permissions explicitly, and prefer a static token tied to a narrow service-account role over making a collection fully public.

## CORS

Browser clients on a different origin from CairnCMS need CORS to be enabled on the CairnCMS instance. CORS is configured operator-side through environment variables (`CORS_ENABLED`, `CORS_ORIGIN`, and friends). See the deployment and configuration sections under Manage for the full list.

## Where to go next

- [Auth](/docs/guides/auth/) — SSO, two-factor, sessions, and static tokens in depth.
- [Permissions](/docs/guides/permissions/) — how to scope what each role and the public role can see and do.
- API reference — endpoint reference, filter rules, and the SDK API surface.
