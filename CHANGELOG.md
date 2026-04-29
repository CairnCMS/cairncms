# Changelog

All notable changes to CairnCMS are documented in this file. Releases are listed in reverse chronological order. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-29

First public release of CairnCMS, a community-maintained fork of Directus v10.

### Major changes from upstream Directus

- **License.** GPLv3, replacing the original BUSL-1.1.
- **Telemetry removed.** CairnCMS does not phone home.
- **Package scope.** First-party packages publish under `@cairncms/*`. CLI binary: `cairncms`. Extension CLI: `cairncms-extension`.
- **Node 20 baseline.** Minimum Node 20.0.0. Node 18 dropped.
- **Supported database vendors.** SQLite, PostgreSQL (current and 10.x LTS), MySQL (8 and 5.7), and MariaDB exercised in CI. Oracle, MS SQL Server, and CockroachDB still supported in code but no longer covered by CI.
- **Vendored dependencies.** `@directus/format-title` → `@cairncms/format-title`. `@directus/tsconfig` replaced with a local shared TypeScript config.
- **JavaScript SDK.** `@cairncms/sdk` — composable REST and GraphQL client, vendored from `@directus/sdk`. Factory: `createCairnCMS`. Client type: `CairnCMSClient`.
- **First-party Mapbox styles.** Default basemaps now use Mapbox stock styles rather than Directus-owned UUIDs.

### New features

- **Config-as-code (v1).** Roles and permissions exportable to / applicable from a versioned YAML directory. New CLI: `cairncms config snapshot`, `cairncms config apply`.
- **Public-role sentinel.** The "public" (unauthenticated) role is a reserved-UUID row instead of NULL. Adds a uniqueness constraint on `(role, collection, action)` eliminating duplicate-permission `_or` merging.
- **Rebranded admin theme.**

### Security and reliability

- Removed CORS origin fallback to a permissive wildcard. `CORS_ENABLED=true` now requires explicit `CORS_ORIGIN`.
- Gated OAuth2 and OpenID Connect state cookies on `REFRESH_TOKEN_COOKIE_SECURE`.
- Multiple rounds of dependency updates resolving published CVEs.
- Fixed date-only fields shifting by one day in non-UTC timezones.

### Migration notes for Directus operators

- Refresh-token cookie: now `cairncms_refresh_token` (was `directus_refresh_token`). Override via `REFRESH_TOKEN_COOKIE_NAME=directus_refresh_token` to preserve existing sessions.
- Messenger namespace: now `cairncms` (was `directus`). Override via `MESSENGER_NAMESPACE=directus` for drop-in compatibility.
- `/server/info`: top-level `directus` key is now `cairncms`. Update consumers of `response.data.directus.version`.
- DB table names (`directus_users`, `directus_roles`, etc.) **preserved**. GraphQL system schema names and OpenAPI identifiers derived from these tables also preserved.
- **SDK**: factory `createCairnCMS` (was `createDirectus`); client type `CairnCMSClient` (was `DirectusClient`). Schema-mirror types (`DirectusUser`, `DirectusFile`, etc.) and command names (`readItems`, etc.) unchanged.
- **Docker**: container working directory and default storage paths now under `/cairncms` (was `/directus`). Update bind mounts. Base image: `node:20-alpine`.

### Acknowledgements

The CairnCMS codebase originated in Directus v10. Thanks to the Directus team and contributors.
