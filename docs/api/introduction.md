---
title: Introduction
description: How the CairnCMS API is shaped — REST, GraphQL, request and response envelopes, authentication, errors, and how to choose the surface that fits your client.
---

CairnCMS exposes the platform through two parallel APIs: a REST API and a GraphQL API. They overlap heavily and most everyday CRUD work the same way through either surface. They are not strictly equivalent, though: a small number of operator-side surfaces (the `/schema/*` and `/config/*` endpoints, and a handful of utility routes) are REST-only.

For application code, treat the choice as one of ergonomics. For operator and CI tooling, prefer REST since some of what you need is only there.

This page covers the shape both APIs share: URL conventions, the response envelope, authentication, errors, and the system-versus-user split. Subsequent pages cover individual surfaces in depth.

## A schema-driven API

The API is generated from your data model rather than hand-coded for each project. When you add a collection in the app, a new `/items/<collection>` REST endpoint and corresponding GraphQL types appear immediately. When you add a field, that field becomes available as a query parameter, in `fields[]`, and as a GraphQL selection. There is no build step and no client code generation required server-side.

Two consequences:

- **The API surface differs between deployments.** Two CairnCMS instances with different schemas have different APIs. The reference pages describe the conventions that apply to every deployment; the specifics come from your project.
- **Permissions filter every request.** What an authenticated request can read or write depends on the role's permissions. Two clients hitting the same endpoint with different tokens may see different fields, different rows, or no access at all. The permission layer is part of the API's correctness, not a layer in front of it.

## Base URL

Every API path is relative to the deployment's `PUBLIC_URL`. For a CairnCMS instance reachable at `https://cms.example.com`:

```
https://cms.example.com/items/articles
https://cms.example.com/auth/login
https://cms.example.com/graphql
```

The reference pages omit the base URL and use just the path. Substitute your deployment's URL when invoking the endpoints.

## REST or GraphQL

For data access, both surfaces cover the same ground: every collection, system or user-defined, can be read and written through either. The right choice for an application client depends on the shape of its queries:

- **REST** suits straightforward CRUD against a single resource, server-to-server scripts, and tooling that benefits from familiar HTTP semantics (curl, OpenAPI consumers, HTTP-based caches). Most operator scripts and automation use REST.
- **GraphQL** suits clients that compose deep queries across many relations, fetch only the fields they need, or want a typed schema for code generation. Application frontends often benefit, especially when combined with a query-aware client library.

The operator-side surfaces (`/schema/snapshot`, `/schema/diff`, `/schema/apply`, `/config/snapshot`, `/config/apply`) are REST-only. So is asset serving (`/assets/<id>`) and a handful of utility routes. CI scripts that drive a CairnCMS instance through its lifecycle generally end up on REST for that reason.

You can mix the two in the same project. The official SDK supports both behind the same client, so a single application can use REST for some flows and GraphQL for others without managing two transports.

## The response envelope

Successful REST responses follow a consistent envelope:

```json
{
  "data": { ... }
}
```

For collection endpoints that return multiple items, `data` is an array:

```json
{
  "data": [
    { "id": 1, "title": "First" },
    { "id": 2, "title": "Second" }
  ]
}
```

When the request includes `meta=*` or a specific `meta` key, the envelope adds a `meta` object alongside `data`:

```json
{
  "data": [ ... ],
  "meta": {
    "total_count": 42,
    "filter_count": 7
  }
}
```

A few endpoints return raw data without the envelope, i.e. the asset-serving routes return file bytes with the appropriate `Content-Type`, and a small number of utility endpoints return plain JSON for backwards compatibility. Those exceptions are called out on each surface's reference page.

GraphQL responses follow the standard GraphQL shape:

```json
{
  "data": { ... },
  "errors": [ ... ]
}
```

GraphQL collects partial errors alongside any successful selections rather than failing the entire response. REST returns a single error envelope on any failure.

## Authentication

By default, every request must carry an access token. Two ways to attach one:

- **`Authorization` header** — `Authorization: Bearer <token>`. Preferred for server-to-server calls and any context where you control the request.
- **`access_token` query parameter** — `?access_token=<token>`. Useful for asset URLs and other contexts where headers are inconvenient (an `<img>` tag, for example). Avoid in shared logs.

Endpoints that map to permissions configured for the Public role can be reached without a token. Anything outside the Public role's permitted set returns `403 FORBIDDEN`.

For full coverage of login, refresh, OAuth/OIDC/SAML providers, static tokens, and the refresh-cookie flow, see [Authentication](/docs/api/authentication/).

## Errors

REST returns a consistent envelope on failure:

```json
{
  "errors": [
    {
      "message": "You don't have permission to access this.",
      "extensions": {
        "code": "FORBIDDEN"
      }
    }
  ]
}
```

`errors[]` always exists; multiple errors can be returned in a single response when validation collects more than one issue. Each error has a human-readable `message` and a machine-readable `extensions.code`. Treat `extensions.code` as the authoritative signal for what went wrong — the HTTP status code on the response is informative but not the right thing to switch on, especially when an error array contains entries with different statuses.

Errors from internal failures (uncaught exceptions, database connection problems) sanitize their messages for non-admin requesters to avoid leaking stack traces or implementation details. Admins see the full error.

The codes used across the API:

| Code | HTTP status | Meaning |
|---|---|---|
| `FAILED_VALIDATION` | 400 | Field-level validation rejected the payload. |
| `INVALID_PAYLOAD` | 400 | The request body was unparseable or structurally wrong. |
| `INVALID_QUERY` | 400 | Query parameters cannot be combined as requested. |
| `INVALID_CREDENTIALS` | 401 | Login failed, or a token is missing/invalid. |
| `INVALID_OTP` | 401 | TFA code rejected. |
| `INVALID_IP` | 401 | The role's IP allow list rejected the source IP. |
| `TOKEN_EXPIRED` | 401 | Token was valid but has aged out. |
| `INVALID_TOKEN` | 403 | Token is malformed or signed with a different secret. |
| `FORBIDDEN` | 403 | The role does not have permission for this action, or the item does not exist. |
| `ROUTE_NOT_FOUND` | 404 | No such endpoint. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `Content-Type` not accepted by this endpoint. |
| `UNPROCESSABLE_ENTITY` | 422 | The request was syntactically valid but semantically wrong (a constraint violation, for example). |
| `REQUESTS_EXCEEDED` | 429 | Hit the rate limit. |
| `SERVICE_UNAVAILABLE` | 503 | An external dependency (cache, mail, storage) failed. |
| `INTERNAL_SERVER_ERROR` | 500 | An unexpected error. |

To prevent leaking information about which items exist, requests for specific items the caller cannot access return `403 FORBIDDEN` rather than `404 NOT FOUND`. A `404` only comes back for genuinely unmapped routes.

## System data and user data

Every CairnCMS deployment has two kinds of collections: **user collections** that you create through the schema, and **system collections** that the platform owns (`directus_users`, `directus_files`, `directus_roles`, `directus_permissions`, and so on).

In REST, user collections live under `/items/<collection>` and system collections live under their own top-level paths (`/users`, `/files`, `/roles`, `/permissions`, etc.). The two have the same query semantics; the split is about route organization, not capability.

In GraphQL, the namespacing is enforced through two endpoints:

- **`/graphql`** — user collection types and operations.
- **`/graphql/system`** — system collection types and operations.

Both endpoints share the same underlying schema, so deeply-nested relations that cross between user and system data still resolve correctly. The split exists because GraphQL has no built-in namespace mechanism, and putting `users` alongside a user-defined `users` collection would collide.

## The SEARCH method

For very large or deeply-nested REST queries, a `GET` request can run up against URL length limits, particularly when filter trees, deep relations, and long `fields[]` arrays compound. CairnCMS supports the `SEARCH` HTTP method as a drop-in replacement for `GET`, with the query in the request body:

```http
SEARCH /items/articles HTTP/1.1
Content-Type: application/json

{
  "query": {
    "filter": { "status": { "_eq": "published" } },
    "fields": ["id", "title", "author.name"],
    "sort": ["-published_at"],
    "limit": 50
  }
}
```

The request shape is the same query options that would otherwise be query parameters, wrapped in a top-level `query` object. The response is identical to the equivalent `GET` response.

`SEARCH` is wired on collection-list endpoints — `/items/<collection>`, `/users`, `/files`, and the equivalent top-level routes for other system collections. It is not available on item-detail endpoints (`/items/<collection>/<id>`) or on utility endpoints like `/server/info`, where the URL length issue does not arise. Permissions and rate limiting apply the same way they do for `GET`.

## Versioning and stability

CairnCMS follows semver for the platform release. The HTTP API stability commitment for `1.x`:

- Endpoint URLs, request shapes, and response envelopes are stable across minor and patch versions.
- New features add endpoints and fields; existing ones do not change shape.
- Breaking changes happen at major version boundaries and are documented alongside the release.

The auto-generated portions of the API like `/items/<collection>` and the GraphQL schema change with your data model rather than with platform releases. A renamed field changes your project's API surface but is not a platform-API breaking change.

## Where to go next

- [Authentication](/docs/api/authentication/) — login, refresh, providers, static tokens, and the cookie flow.
- [Items](/docs/api/items/) — the conventions for creating, reading, updating, and deleting items in user collections.
- [Files](/docs/api/files/) — uploading, downloading, transforming, and importing assets.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL shared by REST and GraphQL.
- [GraphQL](/docs/api/graphql/) — schema introspection, the `/graphql` and `/graphql/system` split, and the differences from REST.
- [SDK](/docs/api/sdk/) — the official client library for JavaScript and TypeScript.
- [System collections](/docs/api/system-collections/) — the platform-owned tables and their endpoints.
