---
title: System collections
description: The platform-owned tables and the operator endpoints that sit alongside them. What "system collection" means, how they are exposed through REST and GraphQL, and where to find each one.
---

CairnCMS ships with a fixed set of tables that the platform manages directly. They hold users, roles, permissions, files, dashboards, flows, and other state the platform itself reads and writes. The reference pages in this section cover the grouped system-collection surfaces plus the operator endpoints that pair with them. A few of those tables are documented elsewhere or have no general-purpose API surface at all (see [What is a system collection](#what-is-a-system-collection) below).

## What is a system collection

A system collection is any table whose name starts with `directus_`. The full set is fixed: you cannot create or rename one through schema-as-code, and they are filtered out of `cairncms schema snapshot`. Each one has a defined shape that the platform depends on, and the API exposes them through dedicated top-level paths rather than `/items/<collection>` (which is reserved for user-defined collections).

The full set:

`directus_users`, `directus_roles`, `directus_permissions`, `directus_shares`, `directus_files`, `directus_folders`, `directus_presets`, `directus_flows`, `directus_operations`, `directus_webhooks`, `directus_dashboards`, `directus_panels`, `directus_notifications`, `directus_collections`, `directus_fields`, `directus_relations`, `directus_settings`, `directus_activity`, `directus_revisions`, `directus_migrations`, `directus_sessions`.

`directus_files` has its own page at [Files](/docs/api/files/) since the asset-serving surface is large enough to warrant separate treatment. The remaining collections are grouped on the pages linked below.

## REST exposure

Every system collection has its own top-level REST path, named by stripping the `directus_` prefix and pluralising as needed:

| Collection | Path |
|---|---|
| `directus_users` | `/users` |
| `directus_roles` | `/roles` |
| `directus_permissions` | `/permissions` |
| `directus_shares` | `/shares` |
| `directus_folders` | `/folders` |
| `directus_presets` | `/presets` |
| `directus_flows` | `/flows` |
| `directus_operations` | `/operations` |
| `directus_webhooks` | `/webhooks` |
| `directus_dashboards` | `/dashboards` |
| `directus_panels` | `/panels` |
| `directus_notifications` | `/notifications` |
| `directus_collections` | `/collections` |
| `directus_fields` | `/fields` |
| `directus_relations` | `/relations` |
| `directus_settings` | `/settings` |
| `directus_activity` | `/activity` |
| `directus_revisions` | `/revisions` |
| `directus_files` | `/files` |

The shape of each path follows the same conventions as `/items/<collection>`: list, single-item, batch, by-keys, by-query. See [Items](/docs/api/items/) for the shared semantics. The grouped pages cover the per-collection quirks (which actions are exposed, which fields are computed, which payloads have non-standard shapes).

`directus_migrations` and `directus_sessions` are platform-internal and have no general-purpose REST surface. Reach migrations through the CLI; sessions are managed through the auth flow.

## GraphQL exposure

System collections are exposed through `/graphql/system`, separate from the user-collection root at `/graphql`. The split is documented in [GraphQL](/docs/api/graphql/). Many collections follow the standard generated CRUD shape (`<collection>`, `<collection>_by_id`, `create_<collection>_item`, and so on), but the system endpoint also includes several non-standard cases worth knowing about: `directus_collections`, `directus_fields`, and `directus_relations` have bespoke resolvers in place of the generic CRUD shape; `directus_activity` skips the generic mutations but adds dedicated comment mutations; `directus_files` adds an `import_file` mutation alongside the generic shape; and `directus_revisions` is read-only.

`/graphql/system` also hosts the auth and TFA mutations (`auth_login`, `auth_refresh`, `auth_logout`, `auth_password_request`, `auth_password_reset`, `users_me_tfa_generate`, `users_me_tfa_enable`, `users_me_tfa_disable`) and a small set of operator queries (`server_info`, `server_health`, `server_ping`, `server_specs_oas`, `server_specs_graphql`).

The full per-collection map of what is and is not exposed is in [GraphQL / What `/graphql/system` exposes](/docs/api/graphql/#what-graphql-system-exposes).

## Query DSL

Every list and search endpoint accepts the same query options as user collections: `fields`, `filter`, `search`, `sort`, `limit`, `offset`, `page`, `aggregate`, `groupBy`, `meta`, `deep`, `alias`. Filter operators (`_eq`, `_in`, `_contains`, and so on) and filter variables (`$NOW`, `$CURRENT_USER`, `$CURRENT_ROLE`) all work the same way. See [Filters and queries](/docs/api/filters-and-queries/) for the full reference.

## Permissions

System collections are gated by role permissions the same way user collections are. Reading `/users` returns only the user records the role is permitted to read; updating `/permissions` requires create/update permission on the `directus_permissions` collection.

Two practical consequences worth knowing up front:

- The default Public role has no permissions on system collections. To expose any system data without authentication, configure the Public role explicitly. Be specific about the filter and field allow-list when you do.
- Several system collections are admin-only by default *for writes*. The platform projects narrow read permissions on most of them so the admin app can render schema-aware UI and per-user views: `directus_settings` is fully readable by app-access roles (the admin app needs branding and project defaults), and `directus_roles`, `directus_permissions`, `directus_collections`, `directus_fields`, and `directus_relations` are readable by app-access roles with appropriate per-role or per-collection filters. Writes on those collections are still admin-only by default. Granting non-admin write is sometimes legitimate but should be a deliberate decision rather than an oversight.

## How the grouped pages are organized

The reference is split into seven topical pages plus this hub. Most pages cover row-backed system collections; two cover collections plus adjacent operational endpoints that pair with them semantically:

- **[Access control](/docs/api/system-collections/access-control/)** — `directus_users`, `directus_roles`, `directus_permissions`, `directus_shares`, plus the `/config/snapshot` and `/config/apply` endpoints that snapshot and apply role/permission state.
- **[Organization](/docs/api/system-collections/organization/)** — `directus_folders` and `directus_presets`. Folders organize files; presets store per-user view configurations.
- **[Automation](/docs/api/system-collections/automation/)** — `directus_flows`, `directus_operations`, `directus_webhooks`. The platform's event-driven automation surface.
- **[Insights and UI](/docs/api/system-collections/insights-and-ui/)** — `directus_dashboards`, `directus_panels`, `directus_notifications`. Dashboard composition and the user-facing notification feed.
- **[Schema and modeling](/docs/api/system-collections/schema-and-modeling/)** — `directus_collections`, `directus_fields`, `directus_relations`, plus the `/schema/snapshot`, `/schema/diff`, and `/schema/apply` endpoints. The full schema-introspection and schema-as-code surface in one place.
- **[Activity and revisions](/docs/api/system-collections/activity-and-revisions/)** — `directus_activity` and `directus_revisions`. The audit trail and per-row history.
- **[Platform and utilities](/docs/api/system-collections/platform-and-utilities/)** — `directus_settings` (a singleton row-backed collection), the `/server/*` operator endpoints, the `/utils/*` utility endpoints, and the `/extensions` endpoint.

The first five groups cover row-backed collections only, occasionally paired with the operator endpoints that snapshot and apply that same state. The last two groups (and especially Platform and utilities) include endpoints that are not collection-shaped at all, like server health checks and cache flushing. Read the page intros for the precise scope.

## Where to go next

- [Items](/docs/api/items/) — the user-collection CRUD shape that system collections mirror.
- [Filters and queries](/docs/api/filters-and-queries/) — the query options shared with user collections.
- [GraphQL](/docs/api/graphql/) — the `/graphql/system` endpoint and the per-collection exposure rules.
- [Authentication](/docs/api/authentication/) — the auth and TFA mutations that live alongside the system collections on `/graphql/system`.
