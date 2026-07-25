---
title: Platform and utilities
description: The mixed bag at the edge of the API. The settings singleton, the server info / health / specs endpoints, the extensions discovery and extension-settings endpoints, and the `/utils/*` operator routes.
sidebar:
  order: 7
---

This page covers the surfaces that are adjacent to the system-collection model but do not fit neatly into the row-backed CRUD pattern most of the system collections follow. Some of these are technically system collections (`directus_settings` is one row in `directus_settings`), but most are operational endpoints that expose platform state or perform one-shot operator actions.

If you are looking for `/items`-style collection CRUD, this is not the page. Read each section's intro to know what shape to expect.

## Settings (`/settings`)

`directus_settings` is a singleton: there is one row, and it holds project-wide configuration that the admin app reads on every page load. Branding, default storage, asset transform policies, password policy, login attempt limits, and a few other operator-managed values live here.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/settings` | Read the settings singleton. |
| `PATCH` | `/settings` | Upsert the settings singleton (creates the row on first call, updates it thereafter). |

There is no `POST /settings` or `DELETE /settings`. The row is conceptually permanent; the platform creates it on demand the first time `PATCH /settings` is called.

### Settings record fields

The settings row carries dozens of fields. The notable ones:

- **`project_name`**, **`project_descriptor`**, **`project_url`**, **`project_logo`**, **`project_color`** — branding shown in the admin app and in transactional emails.
- **`public_foreground`**, **`public_background`**, **`public_note`**, **`public_favicon`** — branding for the public-facing login screen.
- **`default_language`**, **`default_appearance`**, **`default_theme_light`**, **`default_theme_dark`** — default per-user preferences for new accounts.
- **`auth_password_policy`** — the password complexity regex.
- **`auth_login_attempts`** — count of failed logins before lockout. Default `25`.
- **`storage_asset_transform`**, **`storage_asset_presets`** — control which asset transformations the platform accepts. See [Files / Image transformations](/docs/api/files/#image-transformations).
- **`storage_default_folder`** — folder UUID that uploads default into when no folder is specified.
- **`mapbox_key`** — token for the map layout's tile provider.
- **`module_bar`** — array of module IDs and ordering for the admin app's module bar.
- **`custom_css`** — inline CSS injected into the admin app, used for branding and small UI overrides.
- **`custom_aspect_ratios`** — operator-defined aspect ratios for image transforms.

`PATCH /settings` accepts a partial body; only the fields you include are touched. Operators rarely write the full row.

## Server (`/server/*`)

The `/server` subtree exposes platform state and machine-readable specifications. None of these routes touch a row in the database in a write sense; they are read-only operator and tooling routes.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/server/info` | Project info, version, and feature flags. |
| `GET` | `/server/health` | Liveness and readiness checks across database, cache, rate limiter, storage, and email. |
| `GET` | `/server/specs/oas` | The platform's OpenAPI 3 specification, dynamically generated from the running schema. |
| `GET` | `/server/specs/graphql/<scope>` | The GraphQL SDL for one of the two endpoints. `<scope>` is `items` (default) or `system`. |

### `GET /server/info`

Returns a `data` envelope whose contents depend on the caller's accountability:

- **Unauthenticated callers** receive only the public branding subset: `project.project_name`, `project_descriptor`, `project_logo`, `project_color`, `default_language`, `public_foreground`, `public_background`, `public_note`, and `custom_css`. This is what the admin app reads on the login screen before the user has authenticated.
- **Authenticated users** additionally receive `rateLimit` and `rateLimitGlobal` blocks describing the configured rate-limiter policy.
- **Authenticated users and share sessions** receive a `queryLimit` block with `default` and `max`, the configured query-limit policy. The admin app reads it to size its paginated requests. A `max` of `-1` means no ceiling.
- **Admins** additionally receive `cairncms.version`.

The platform version is admin-only on this endpoint. Clients that need to detect the running version without admin credentials should look at the package's published version channel rather than reading it from `/server/info`.

### `GET /server/health`

Returns a health-check payload following the `application/health+json` convention. The response includes overall status (`ok`, `warn`, `error`) and per-subsystem checks for database, cache, rate limiter, storage, and email. The HTTP status is `200` on `ok` or `warn` and `503` on `error`. The endpoint opts out of caching, so each call reflects current state.

The endpoint is unauthenticated for the overall status and gated behind admin access for the per-subsystem detail. Use this as a load balancer health probe and as the entry point for operator monitoring.

### `GET /server/specs/oas`

Generates an OpenAPI 3 document for the running deployment. The spec includes every collection (user-defined and system) that the requesting role can read, with collection-tagged paths filtered by per-collection permissions. Tags that do not represent a collection (Server, Utilities, Extensions, Schema, Auth, and so on) are included unconditionally. So `/utils/cache/clear` shows up in the spec for every caller, even though only admins can successfully invoke it. Use the per-route descriptions and the underlying permission model to understand which calls will succeed; do not infer reachable surface from spec inclusion alone.

Useful for code generators (openapi-generator, openapi-typescript), API explorers (Swagger UI, Redoc), and any tooling that consumes OpenAPI to scaffold client code.

### `GET /server/specs/graphql/<scope>`

Returns the GraphQL SDL for one of the two GraphQL endpoints, served as a `.graphql` attachment. Pass `<scope>` as `items` (the user-collection root at `/graphql`) or `system` (the system-collection root at `/graphql/system`). Omitting the scope defaults to `items`.

The downloaded file works with code generators (graphql-codegen) and any GraphQL-aware tooling. The SDL is generated dynamically against the running schema and the requesting role's permissions, so the same caveat as OpenAPI applies: two roles see different SDLs from the same deployment.

This endpoint is gated by `GRAPHQL_INTROSPECTION`. When introspection is disabled, the endpoint returns a 403, alongside the corresponding rejection on `__schema` and `__type` queries. See [GraphQL / Schema introspection](/docs/api/graphql/#schema-introspection).

## Extensions (`/extensions/*`)

The `/extensions` subtree exposes the platform's installed extensions. There is no `directus_extensions` table. Extensions live on disk and are discovered at startup. The endpoints expose admin-only load diagnostics for the discovered set, plus the JavaScript chunks the admin app loads at runtime.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/extensions` | Admin-only load diagnostics for every discovered extension. |
| `GET` | `/extensions/sources/<chunk>` | Fetch the bundled JavaScript chunk for app extensions. |

### `GET /extensions`

Returns load diagnostics for every discovered extension. This endpoint is admin-only. A non-admin caller gets `403 FORBIDDEN`.

```http
GET /extensions
```

```json
{
  "data": [
    {
      "name": "audit-hook",
      "type": "hook",
      "local": true,
      "status": "loaded"
    },
    {
      "name": "cairncms-extension-color-picker",
      "type": "interface",
      "local": false,
      "status": "discovered",
      "version": "1.2.0"
    },
    {
      "name": "cairncms-extension-shout-operation",
      "type": "operation",
      "local": true,
      "status": "loaded",
      "runtime": "confined-server",
      "capabilities": { "log": true, "items": { "accountability": "user" } },
      "settings": { "status": "available" }
    },
    {
      "name": "cairncms-extension-metrics-bundle",
      "type": "bundle",
      "local": true,
      "status": "partial",
      "runtime": "confined-server",
      "entries": [
        { "name": "metric-card", "type": "panel", "status": "loaded" },
        {
          "name": "metric-feed",
          "type": "endpoint",
          "status": "failed",
          "reason": { "code": "ROUTE_COLLISION", "detail": "the confined endpoint route is already registered" },
          "capabilities": { "endpoint": { "access": "authenticated" }, "request": { "urls": ["https://api.example.com"], "methods": ["GET"] } }
        }
      ]
    },
    {
      "name": "broken-endpoint",
      "type": "endpoint",
      "local": true,
      "status": "failed",
      "reason": { "code": "ENTRYPOINT_NOT_FOUND", "detail": "Cannot find the extension entrypoint." }
    }
  ],
  "meta": {
    "confinedRuntime": {
      "state": "available",
      "posture": {
        "mode": "auto",
        "decision": "run",
        "applied": ["network-namespace", "permission-model"],
        "missing": ["cgroup-memory"],
        "cgroupMechanic": null
      }
    }
  }
}
```

Each row has `name`, `type`, `local`, and `status`. A server extension that registered into the API has status `loaded`. An app extension that was found on this instance has status `discovered`: it runs in the browser rather than the server, and the row appears whether or not this instance serves the admin app. An extension that errored during discovery, build, or registration has status `failed` and carries a `reason` object with a stable `code` and a `detail` that has been run through the platform's error redaction, so the diagnostics never expose raw paths or secrets from the underlying error. A bundle whose entries did not all load has status `partial`.

A confined (sandboxed) extension also carries `runtime: "confined-server"` and the `capabilities` it declared. A bundle lists its nested extensions under `entries`, each with its own `name`, `type`, `status`, optional `reason`, and `capabilities`. The optional `version` field appears when available.

An extension that declares settings carries a `settings` field: `{ "status": "available" }` when its settings are editable, or `{ "status": "unavailable", "reason": { "code": "...", "detail": "..." } }` when the settings subject is refused. The reason codes are `SETTINGS_SUBJECT_INVALID` (the package name is not a valid extension name), `SETTINGS_SUBJECT_DUPLICATE` (more than one installed extension uses the name), and `SETTINGS_SUBJECT_CONFIG_COLLISION` (two packages derive the same config-secret deployment variable). An unavailable subject affects the settings surface only, never whether the extension loads.

The `meta.confinedRuntime` object reports the global confined-runtime state (`not-required`, `available`, or `unavailable`) and, when available, the resolved OS hardening `posture`: the `mode` (`auto` or `required`), the `decision` (`run` or `refuse`), the hardening layers `applied` and `missing`, and the `cgroupMechanic` in use.

This is the only `/extensions` route that requires authentication. The source route below is reachable without a token.

### `GET /extensions/sources/<chunk>`

Serves the bundled JavaScript code for installed app extensions. The admin app calls `/extensions/sources/index.js` at boot to load every app-side extension's code, plus follow-up calls to load chunks named by the manifest. The response is `application/javascript` with a `Cache-Control` header derived from `EXTENSIONS_CACHE_TTL`.

Operators rarely call this directly. It exists for the admin app's runtime loader.

## Extension settings (`/extension-settings/*`)

Stored operator values for the settings an extension declares in its manifest. The values live in internal platform storage reached only through these routes. There is no generic collection, no `/items` path, and nothing in the `/schema` snapshot. See [Extension settings](/docs/develop/extensions/settings/) for the declaration model these routes serve.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/extension-settings` | Admin-only. Stored values for one subject, optionally filtered by scope. |
| `POST` | `/extension-settings` | Admin-only. Set one value. |
| `DELETE` | `/extension-settings` | Admin-only. Clear one value, or purge a subject. |
| `GET` | `/extension-settings/owners` | Admin-only. Every settings-declaring extension, with its declaration or refusal reason. |
| `GET` | `/extension-settings/app` | App access. Non-secret app-readable values, for app extension code. |

### `GET /extension-settings`

Returns the stored values for one subject. `subject` is required, `scope` (`global` or `collection`) and `scope_key` are optional filters.

```http
GET /extension-settings?subject=cairncms-extension-chat-notify&scope=global&scope_key=
```

```json
{
  "data": [
    { "scope": "global", "scope_key": "", "key": "sender_name", "value": "Newsroom Bot" },
    { "scope": "global", "scope_key": "", "key": "api_token", "value": "**********" }
  ]
}
```

A stored secret always reads back as the mask, never the value.

### `POST /extension-settings`

Sets one value. The body requires all five fields; a global value uses an empty `scope_key`.

```json
{ "subject": "cairncms-extension-chat-notify", "scope": "collection", "scope_key": "articles", "key": "channel", "value": "#news" }
```

A write to a key the subject does not declare, a value of the wrong type, or a collection `scope_key` that names no existing collection is refused with `400 INVALID_PAYLOAD`. So is a write to a config-sourced secret, which is provisioned in deployment config and never stored, and a write of the literal mask back to a secret key. Writing an inline secret when `SECRETS_ENCRYPTION_KEY` is not configured fails with `503 INVALID_CONFIG` naming the missing configuration.

### `DELETE /extension-settings`

Accepts exactly two body shapes and refuses everything else with `400 INVALID_PAYLOAD`, so a malformed request can never escalate a one-value clear into a purge.

```json
{ "subject": "cairncms-extension-chat-notify", "scope": "collection", "scope_key": "articles", "key": "channel" }
```

clears one value, and

```json
{ "subject": "cairncms-extension-chat-notify" }
```

purges every value stored for the subject. Both return `{ "data": { "removed": <count> } }`.

### `GET /extension-settings/owners`

Returns every installed extension that declares settings. An available owner carries its raw `subject` and full `declaration`; an unavailable owner carries only a sanitized `displaySubject` and the refusal `reason`, so an invalid package name is never echoed raw.

```json
{
  "data": [
    {
      "subject": "cairncms-extension-chat-notify",
      "displaySubject": "cairncms-extension-chat-notify",
      "status": "available",
      "declaration": { "api_token": { "type": "string", "scope": "global", "secret": { "source": "inline" } } }
    },
    {
      "displaySubject": "bad-subject",
      "status": "unavailable",
      "reason": { "code": "SETTINGS_SUBJECT_INVALID", "detail": "the settings subject \"bad-subject\" is not a valid extension package name" }
    }
  ]
}
```

### `GET /extension-settings/app`

Serves declared keys marked `appReadable` to app extension code. `subject` is required, `collection` is optional. The response maps key to value. Global app-readable values are always included. Collection-scoped values are included only when `collection` is supplied and the caller's permissions allow reading that collection. Secret keys are never served, because a secret can never be app-readable.

```http
GET /extension-settings/app?subject=cairncms-extension-chat-notify&collection=articles
```

```json
{ "data": { "channel": "#news" } }
```

This is the one route in the subtree that does not require admin. It requires a signed-in user whose role has app access.

## Utils (`/utils/*`)

The `/utils` subtree is a grab bag of operational helpers that don't fit anywhere else. Most are admin-only, and most are one-shot actions rather than CRUD on a resource.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/utils/random/string` | Generate a random URL-safe string. |
| `POST` | `/utils/hash/generate` | Argon2-hash a string. |
| `POST` | `/utils/hash/verify` | Verify a string against an Argon2 hash. |
| `POST` | `/utils/sort/<collection>` | Reorder items in a sortable collection. |
| `POST` | `/utils/revert/<revision-id>` | Revert an item to a specific revision. |
| `POST` | `/utils/import/<collection>` | Import items from a CSV or JSON file (multipart upload). |
| `POST` | `/utils/export/<collection>` | Async export of a query result to a file in the configured storage backend. |
| `POST` | `/utils/cache/clear` | Flush the platform's caches. Admin-only. |

### `GET /utils/random/string`

```http
GET /utils/random/string?length=24
```

Returns `{ "data": "<random-string>" }`. The `length` query parameter is optional; the default is `32` and the maximum is `500`.

### `POST /utils/hash/generate` and `POST /utils/hash/verify`

Generate and verify Argon2 hashes against arbitrary strings. Useful when an external system needs to interoperate with the platform's password hashes.

```http
POST /utils/hash/generate
Content-Type: application/json

{ "string": "<plaintext>" }
```

Response: `{ "data": "<argon2-hash>" }`.

```http
POST /utils/hash/verify
Content-Type: application/json

{ "string": "<plaintext>", "hash": "<argon2-hash>" }
```

Response: `{ "data": true | false }`.

### `POST /utils/sort/<collection>`

Reorders items in a collection that has a `sort` field configured.

```http
POST /utils/sort/articles
Content-Type: application/json

{ "item": "<id-of-item-being-moved>", "to": "<id-of-the-item-it-should-end-up-before>" }
```

The platform updates the `sort` values on the affected rows so that the moved item lands immediately before the target item. Returns `200` with no body.

### `POST /utils/revert/<revision-id>`

Reverts the item described by the named revision to that revision's state. The operation produces a new activity row and a new revision row recording the revert, so the audit trail stays consistent. See [Activity and revisions / Reverting](/docs/api/system-collections/activity-and-revisions/#reverting) for the full reference.

### `POST /utils/import/<collection>`

Accepts a multipart upload of a CSV or JSON file and imports the rows into the named collection. The MIME type of the file part determines how the contents are parsed.

```http
POST /utils/import/articles
Content-Type: multipart/form-data; boundary=...

------boundary
Content-Disposition: form-data; name="file"; filename="articles.csv"
Content-Type: text/csv

<csv contents>
------boundary--
```

The endpoint returns `200` with no body when the import completes. Errors during import (validation failures, foreign key violations, malformed rows) abort the import and return a standard error envelope.

### `POST /utils/export/<collection>`

Exports a query result to a file in the configured storage backend. Unlike the other utility endpoints, this runs asynchronously: the request returns immediately and the export proceeds in the background.

```http
POST /utils/export/articles
Content-Type: application/json

{
  "query": {
    "filter": { "status": { "_eq": "published" } },
    "fields": ["id", "title", "author.name"]
  },
  "format": "csv",
  "file": { "folder": "<folder-id>" }
}
```

Body fields:

- **`query`** (required) — the same query DSL used for `GET /items/<collection>` (see [Filters and queries](/docs/api/filters-and-queries/)).
- **`format`** (required) — `csv`, `json`, `xml`, or `yaml`.
- **`file`** (optional) — metadata for the resulting `directus_files` row. Useful for placing the export in a specific folder.

The export creates a new file in `directus_files` with the result content. Watch `directus_files` for the new row to know when the export has finished.

The top-level `limit` accepted here is `-1` or an integer of at least `0`, and a `null` or omitted limit is treated as unlimited. Anything else returns `400 INVALID_QUERY`. Because the export streams to a file in batches, its top-level row count is exempt from `QUERY_LIMIT_MAX`: `-1`, `null`, or an omitted limit exports every matching row, and a positive `limit` above the ceiling is honored. A `limit` of `0` produces a format-valid empty export, `[]` for JSON and an empty file for CSV. Nested relational lists keep ordinary query-limit behavior, so a nested `_limit` above a configured maximum is rejected (see [Query limits](/docs/manage/configuration/#query-limits)).

### `POST /utils/cache/clear`

Flushes every cache the platform maintains: response cache, schema cache, permissions cache. Admin-only; non-admin callers get `403 FORBIDDEN`.

```http
POST /utils/cache/clear
```

Returns `200` with no body. Useful after schema changes that the cache might not have picked up automatically, or as a debugging step when stale data is suspected.

## Permission semantics

The collections and endpoints on this page span the permission model:

- **`directus_settings`** — read access is broadly granted by default so the admin app can render branding and pick up project preferences. Write access is admin-only by default.
- **`/server/info`**, **`/server/health`**, and the spec routes — operator-facing rather than collection-CRUD. The basic `/server/info` and `/server/health` endpoints do not require authentication; spec generation and the per-subsystem `/server/health` detail are scoped to admin-readable schema.
- **`/extensions`** — admin-only. The root diagnostics route returns `403 FORBIDDEN` to non-admins.
- **`/extensions/sources/<chunk>`** — unauthenticated. The admin app loads the bundled extension JavaScript on its login screen before anyone signs in, so this route cannot require a token. It serves client-side bundle code, the same as the static admin assets under `/admin`.
- **`/extension-settings`** — admin-only, except `GET /extension-settings/app`, which requires a signed-in user with app access and applies the caller's collection read permissions to collection-scoped values.
- **`/utils/*`** — varies. `random/string` and `hash/*` are unauthenticated. `sort`, `revert`, `import`, and `export` require accountability and are gated by per-collection permissions. `cache/clear` is admin-only.

## GraphQL

The settings collection appears on `/graphql/system` with singleton-shaped resolvers: a `settings` query that calls `readSingleton` and an `update_settings` mutation that calls `upsertSingleton`. There is no `settings_by_id` or batch-create / batch-delete; the GraphQL surface mirrors the REST `GET /settings` and `PATCH /settings` shape.

The server queries (`server_info`, `server_health`, `server_ping`, `server_specs_oas`, `server_specs_graphql`) live on `/graphql/system` as ordinary queries. See [GraphQL / What `/graphql/system` exposes](/docs/api/graphql/#what-graphql-system-exposes) for the full list.

`/graphql/system` also exposes an `extensions` query that returns the installed app-side extensions (`interfaces`, `displays`, `layouts`, `modules`) as nested string arrays. It does not cover hooks, endpoints, operations, or bundles, and there is no GraphQL equivalent of `/extensions/sources/<chunk>` (the bundled-JS loader is REST-only by necessity). The extension-settings surface is REST-only too: none of the `/extension-settings` routes have a GraphQL equivalent.

The rest of `/utils` is REST-only. There is no GraphQL equivalent for cache flushing, asset import / export, sort, revert, hash generation, or random string generation.

## Where to go next

- [Configuration](/docs/manage/configuration/) — environment variables that complement many of the settings on this page (storage, mail, rate limiting, cache).
- [Activity and revisions](/docs/api/system-collections/activity-and-revisions/) — the revision model that `POST /utils/revert/<revision-id>` operates on.
- [Files](/docs/api/files/) — the asset surface that interacts with the export endpoint and the `storage_*` settings.
- [Schema as code](/docs/manage/schema-as-code/) — the `/schema/*` endpoints that share an admin-operator role with `/utils/cache/clear`.
