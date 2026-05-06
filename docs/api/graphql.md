---
title: GraphQL
description: The two GraphQL endpoints, what they expose, the request format, schema introspection, and the surfaces that are intentionally REST-only.
sidebar:
  order: 6
---

CairnCMS exposes a GraphQL API alongside REST. The two share the same underlying services, so most of the same data and operations are reachable through either. GraphQL adds the things GraphQL is good at (selections, native aliases, nested arguments, typed schemas for code generation) and leaves a small set of operator-side surfaces on REST only.

This page covers the endpoint split, the request format, what each endpoint exposes, and the surfaces that intentionally do not have a GraphQL counterpart.

## Two endpoints

The GraphQL surface is split across two roots:

- **`/graphql`** — user collections. Items in the collections you create through the schema, plus the corresponding query/mutation operations.
- **`/graphql/system`** — system collections. `directus_users`, `directus_files`, `directus_roles`, `directus_permissions`, `directus_settings`, and the auth and utility mutations.

The split exists because GraphQL has no native namespace mechanism. Putting `users` (the system collection) alongside a user-defined `users` collection would collide. The two endpoints share the same underlying schema, so a query that traverses from a user collection into a system collection (or vice versa) resolves correctly through nested selections. The split affects which root operations are available, not which related data is reachable.

Both endpoints accept the same request shape. The choice between them is just which root you start from.

## Request format

GraphQL accepts both GET and POST.

```http
POST /graphql
Content-Type: application/json

{
  "query": "query { articles(limit: 5) { id title } }",
  "variables": {},
  "operationName": null
}
```

Body fields:

- **`query`** (required) — the GraphQL document.
- **`variables`** (optional) — variables referenced by the document.
- **`operationName`** (optional) — the operation to execute when the document defines more than one.

GET works the same way, with the fields as query parameters:

```
GET /graphql?query=...&variables=%7B%7D&operationName=...
```

GET requests can only execute queries, not mutations. A document that defines a mutation against a GET request returns `405 METHOD_NOT_ALLOWED`. Use POST for mutations.

The response follows the standard GraphQL envelope:

```json
{
  "data": { "articles": [...] },
  "errors": [...]
}
```

`errors` is omitted when the operation succeeds without partial errors. Unlike REST, GraphQL collects partial errors alongside the successful selections rather than failing the entire response, so check both fields when consuming the result.

## Schema introspection

Schema introspection is on by default. Any GraphQL client can query the `__schema` field to discover types, fields, arguments, and directives.

```graphql
query {
  __schema {
    queryType { name }
    types { name kind }
  }
}
```

Set `GRAPHQL_INTROSPECTION=false` to disable introspection across both endpoints. With introspection off, the server rejects any query that touches `__schema` or `__type`. This is sometimes used as a hardening step on public-facing deployments where the schema shape itself is treated as sensitive.

Disabling introspection breaks Apollo Studio, GraphiQL, and other GraphQL-aware tooling that depend on it. The platform's own admin app does not require introspection on the server side, so disabling it does not affect the app's GraphQL features.

## What `/graphql` exposes

For every user-defined collection, the platform generates:

- **`<collection>`** — a list query, with the arguments documented in [Filters and queries / GraphQL](/docs/api/filters-and-queries/#graphql).
- **`<collection>_by_id(id: ...)`** — a single-item query.
- **`<collection>_aggregated`** — an aggregation query, supporting `groupBy`, `filter`, `limit`, `offset`, `page`, `search`, and `sort`.
- **`create_<collection>_item(data: ...)`** — a single create mutation.
- **`create_<collection>_items(data: ...)`** — a batch create mutation taking an array.
- **`update_<collection>_item(id: ..., data: ...)`** — a single update mutation.
- **`update_<collection>_items(ids: ..., data: ...)`** — a batch update mutation by IDs.
- **`update_<collection>_batch(data: ...)`** — a batch update mutation taking an array of partial records.
- **`delete_<collection>_item(id: ...)`** — a single delete mutation.
- **`delete_<collection>_items(ids: ...)`** — a batch delete mutation.

Singleton collections drop the `_by_id` and per-item mutations and gain an `update_<collection>` mutation that upserts.

Field types in the generated schema match the field types in your data model. Relations resolve as nested object types so deep selections work natively.

## What `/graphql/system` exposes

The system endpoint covers most of the same `directus_*` system collections that REST exposes through top-level paths (`/users`, `/files`, `/roles`, `/permissions`, `/settings`, and so on), with the same generated `users`, `files`, `roles`, etc. operations the user endpoint generates for user collections.

In addition, the system endpoint hosts the auth and TFA mutations:

- **`auth_login(email, password, mode?, otp?)`** — exchange credentials for tokens. `mode: cookie` sets the refresh token as a cookie on the response.
- **`auth_refresh(refresh_token?, mode?)`** — rotate an existing refresh token for a new pair.
- **`auth_logout(refresh_token)`** — invalidate a refresh token.
- **`auth_password_request(email, reset_url?)`** — send a password reset email.
- **`auth_password_reset(token, password)`** — complete a password reset.
- **`users_me_tfa_generate(password)`** — start TFA enrollment for the current user.
- **`users_me_tfa_enable(secret, otp)`** — finish TFA enrollment.
- **`users_me_tfa_disable(otp)`** — disable TFA for the current user.

These match the corresponding REST routes one-to-one. See [Authentication](/docs/api/authentication/) for the body shapes and side effects.

A small set of system collections does not get the auto-generated CRUD shape because their on-disk structure does not fit the generated GraphQL types cleanly:

- `directus_collections`
- `directus_fields`
- `directus_relations`
- `directus_migrations`
- `directus_sessions`

For three of those, the system endpoint instead exposes bespoke resolvers. `directus_collections`, `directus_fields`, and `directus_relations` have custom query resolvers (used by the admin app to introspect the schema) and admin-only mutations like `create_collections_item`, `update_collections_item`, `delete_collections_item`, and the equivalents for fields and relations. The shape of these custom resolvers differs from the generated `<collection>_item` mutations, so consult the introspected schema rather than assuming the user-collection pattern.

`directus_migrations` and `directus_sessions` have no GraphQL surface at all. Reach them through their REST equivalents.

`directus_revisions` is exposed as read-only: queries work, but no mutations are generated. `directus_activity` does not get the auto-generated mutations either, but the system endpoint adds bespoke `create_comment`, `update_comment`, and `delete_comment` mutations backed by activity rows. That keeps comment management on GraphQL even though the broader activity log is not editable.

## What is not in GraphQL

A few surfaces are intentionally REST-only:

- **Asset bytes** at `/assets/<id>`. GraphQL fields are not designed to return raw binary streams.
- **File uploads** at `POST /files` (multipart). Multipart bodies do not fit GraphQL's single-document model. Upload through REST, then use GraphQL for any subsequent metadata work.
- **Schema-as-code endpoints** at `/schema/snapshot`, `/schema/diff`, and `/schema/apply`.
- **Config-as-code endpoints** at `/config/snapshot` and `/config/apply`.
- **Most `/utils` import/export endpoints**, which deal with file streams or shapes that don't translate to a single GraphQL document.

Server-info-style operator queries (`server_info`, `server_health`, `server_ping`, `server_specs_oas`, `server_specs_graphql`) are available on `/graphql/system` alongside the data plane. For application code, GraphQL covers most of what you need; for operator and CI tooling that drives schema, config, or asset bytes, REST is the right surface.

## Caching

GraphQL responses follow the same caching rules as REST. Successful queries are cached when caching is enabled (`CACHE_ENABLED=true`); mutations skip the cache and force the response to be regenerated. The cache key incorporates the request's query and variables, so two structurally different queries against the same data produce two cache entries.

For high-traffic public-facing GraphQL endpoints, an HTTP cache in front of CairnCMS catches the same hits without the application having to evaluate the query. CairnCMS's own cache is the right tool for authenticated requests where the cache key needs to reflect the role and accountability.

## Errors

GraphQL surfaces errors per operation rather than as a single envelope. Each entry in the response's `errors` array describes one issue:

```json
{
  "data": null,
  "errors": [
    {
      "message": "You don't have permission to access this.",
      "extensions": { "code": "FORBIDDEN" },
      "path": ["articles", 0, "author"]
    }
  ]
}
```

The `extensions.code` is the same string set used in REST responses. See [Errors](/docs/api/introduction/#errors) for the full list.

`path` indicates which selection produced the error, which makes partial-success scenarios diagnosable. A query that selects ten articles and one of them has a relation the role cannot read produces a response with the nine articles in `data` and one entry in `errors` pointing at the missing field.

## Where to go next

- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL shared with REST, including the GraphQL argument names and the native-feature equivalents for `fields`, `meta`, `alias`, and `deep`.
- [Authentication](/docs/api/authentication/) — the auth and TFA mutations that live on `/graphql/system`.
- [Items](/docs/api/items/) — the generated CRUD shapes for user collections, with REST and GraphQL examples side by side.
- [System collections](/docs/api/system-collections/) — the `directus_*` collections and which of them are exposed through GraphQL.
