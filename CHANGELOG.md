# Changelog

All notable changes to CairnCMS are documented in this file. Releases are listed in reverse chronological order. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-05-06

First public release of CairnCMS.

### Highlights

CairnCMS 1.0.0 is a fork of Directus v10 relicensed under GPLv3 with telemetry removed and a small set of new operator workflows added on top. The data model, REST and GraphQL APIs, auth flow, permissions, and admin app are derived from Directus v10 and are broadly compatible with it; existing Directus v10 frontends and integrations should require little or no change. This release focuses on relicensing, repackaging under the `@cairncms/*` scope, the operator-facing additions documented below, and a full documentation rewrite.

### Project changes

- **License.** GPLv3, replacing BUSL-1.1.
- **Telemetry removed.** No phone-home and no opt-out flag is needed.
- **Package scope.** First-party packages publish under `@cairncms/*`.
- **CLI binaries.** `cairncms` (was `directus`). Extension CLI: `cairncms-extension`.
- **Vendored format-title.** `@cairncms/format-title` replaces `@directus/format-title`.
- **Local TypeScript config.** Replaces the previous `@directus/tsconfig` shared package.
- **First-party Mapbox styles.** Default basemaps now use Mapbox stock styles. Removes the dependency on Directus-owned Mapbox style UUIDs.
- **Rebranded admin theme.** New brand identity throughout the admin app.

### Platform changes

- **Node 22 baseline.** Minimum Node 22.0.0. Node 20 reached end-of-life in April 2026 and is no longer supported.
- **pnpm 10.x baseline.** Minimum pnpm 10.0.0.
- **Supported database vendors in CI.** SQLite, PostgreSQL (current and 10.x LTS), MySQL (8 and 5.7), and MariaDB.
- **Vendors dropped from CI.** Oracle, Microsoft SQL Server, and CockroachDB still work in code but are no longer covered by automated tests.

### What's new

- **Config-as-code.** Roles and permissions exportable to and applicable from a versioned YAML directory.
  - CLI: `cairncms config snapshot`, `cairncms config apply`.
  - HTTP API: `GET /config/snapshot`, `POST /config/apply` with `dry_run` and `destructive` query flags.
  - Omitted optional fields are preserved (not cleared); set fields explicitly to `null` to clear them.
- **`cairncms init` scaffold.** `npx cairncms init <project>` generates a self-contained Docker Compose project with admin credentials, `.env`, and a starter README. The `cairncms/` subdirectory bind-mounts snapshots, config, extensions, and uploads into the container.
- **Public-role sentinel.** The unauthenticated "public" role is a reserved-UUID row instead of `NULL`. The change adds a uniqueness constraint on `(role, collection, action)` and removes the duplicate-permission `_or` merging path.
- **First-party JavaScript SDK.** `@cairncms/sdk` is a composable REST and GraphQL client vendored from `@directus/sdk`. Factory: `createCairnCMS`. Client type: `CairnCMSClient`.
- **Official Docker images.** Multi-arch (`linux/amd64`, `linux/arm64`) on Docker Hub at `cairncms/cairncms` and GHCR at `ghcr.io/cairncms/cairncms`. Channel tags: `:beta`, `:latest`.
- **Documentation overhaul.** Documentation rewritten end-to-end into six sections (Getting started, Guides, Develop, Manage, API reference, Contributing). 71 pages with consistent structure, code-verified facts, and review applied throughout. The legacy upstream docs at `docs-legacy/` are preserved as an internal reference and not published.

### Breaking changes

- **Run Script capability narrowed.** The `exec` flow operation now runs in an isolated-vm sandbox with no `require()` or host APIs. `FLOWS_EXEC_ALLOWED_MODULES` is removed; pre-1.0 flows that loaded modules need to be rewritten.

### Migration from Directus 10

These are the changes operators coming from Directus 10 will need to account for. Anything not listed here is preserved as-is.

- **Refresh-token cookie name.** `cairncms_refresh_token` (was `directus_refresh_token`). Override with `REFRESH_TOKEN_COOKIE_NAME=directus_refresh_token` to preserve existing sessions across the migration.
- **Messenger namespace.** `cairncms` (was `directus`). Override with `MESSENGER_NAMESPACE=directus` for drop-in compatibility.
- **`/server/info` payload.** Top-level `directus` key is now `cairncms`. Update consumers of `response.data.directus.version`.
- **SDK factory and client type.** `createCairnCMS` (was `createDirectus`); `CairnCMSClient` (was `DirectusClient`). Schema-mirror types (`DirectusUser`, `DirectusFile`, etc.) and command names (`readItems`, etc.) are unchanged.
- **Docker paths.** Container working directory and default storage paths now under `/cairncms` (was `/directus`). Update bind mounts. Base image: `node:22-alpine`.
- **Database table names preserved.** `directus_users`, `directus_roles`, and the rest of the system tables keep their names. GraphQL system schema names and OpenAPI identifiers derived from those tables are also preserved.

### Security and fixes

- Removed CORS origin fallback to a permissive wildcard. `CORS_ENABLED=true` now requires an explicit `CORS_ORIGIN`.
- Gated OAuth2 and OpenID Connect state cookies on `REFRESH_TOKEN_COOKIE_SECURE`.
- Multiple rounds of dependency updates resolving published CVEs.
- Fixed date-only fields shifting by one day in non-UTC timezones.
- Restored default `DB_CLIENT=sqlite3` bootstrap in the published image.
- Replaced vm2 with isolated-vm in the Run Script flow operation.
- Redacted tokens in flow logs (GHSA-f24x-rm6g-3w5v / CVE-2025-53886).
- Send password reset email to the stored address rather than the supplied input (GHSA-qw9g-7549-7wg5 / CVE-2024-27295).
- Unified local-login error responses to prevent SSO user enumeration (GHSA-jgf4-vwc3-r46v / CVE-2024-39896).
- Excluded /auth responses from the response cache (GHSA-cff8-x7jv-4fm8 / CVE-2024-45596).
- Sanitized condition operation validation errors in flow responses (GHSA-fm3h-p9wm-h74h / CVE-2025-30353).
- Added Cross-Origin-Opener-Policy header to /auth routes (GHSA-8m32-p958-jg99 / CVE-2026-35408).
- Stripped server-controlled fields from file metadata writes (GHSA-393c-p46r-7c95 / CVE-2026-39942).
- Canonicalized IPv4-mapped IPv6 addresses before deny-list check in file imports (GHSA-wv3h-5fx7-966h / CVE-2026-35409).
- Memoized GraphQL server_health resolver per request (GHSA-6q22-g298-grjh / CVE-2026-35441).
- Masked concealed fields in aggregate query results (GHSA-38hg-ww64-rrwc / CVE-2026-35442).
- Removed CairnCMS version string from unauthenticated admin bundle (GHSA-5mhg-wv8w-p59j / CVE-2024-27296).
- Validated post-SSO redirect target in OAuth2 and OpenID login flows (GHSA-fr3w-2p22-6w7p / CVE-2024-28239).
- Validated post-SSO redirect target in SAML login flow (GHSA-3573-4c68-g8cc / CVE-2026-22032).
- Canonicalized post-SSO redirect targets to local paths across SSO login flows (GHSA-3573-4c68-g8cc / CVE-2026-22032, GHSA-fr3w-2p22-6w7p / CVE-2024-28239).
- Moved outbound HTTP IP validation to connection time (GHSA-8p72-rcq4-h6pw / CVE-2024-39699).
- Restricted _in/_nin filter operators with empty arrays (GHSA-hxgm-ghmv-xjjm).
- Masked concealed fields routed through query aliases (GHSA-p8v3-m643-4xqx / CVE-2024-34708).
- Deduplicated GraphQL aggregate field selections (GHSA-7hmh-pfrp-vcx4 / CVE-2024-39895).
- Validated share role on create and update (GHSA-pmf4-v838-29hg / CVE-2025-24353).
- Extended outbound IP deny-list to the full loopback range (GHSA-68g8-c275-xf2m / CVE-2024-46990).
- Validated preset ownership on create and update (GHSA-3fff-gqw3-vj86 / CVE-2024-6534).
- Redacted access_token query parameter from request logs (GHSA-vw58-ph65-6rxp / CVE-2024-47822).
- Scoped the search query parameter to fields the caller is permitted to read (GHSA-7wq3-jr35-275c / CVE-2025-30352).
- Avoided opening storage read streams for asset HEAD requests (GHSA-rv78-qqrq-73m5 / CVE-2025-30350).
- Validated asset transform args before opening the source stream (GHSA-j8xj-7jff-46mx / CVE-2025-30225).
- Removed version string from OpenAPI spec responses (GHSA-rmjh-cf9q-pv7q / CVE-2025-53887).
- Required read permission for manual flow triggers (GHSA-7cvf-pxgp-42fc / CVE-2025-53889).
- Cleaned permission references to deleted fields (GHSA-9x5g-62gj-wqf2 / CVE-2025-64746).
- Excluded concealed fields from the search query parameter (GHSA-8jpw-gpr4-8cmh / CVE-2025-64748).
- Closed user-enumeration on the password reset request endpoint (GHSA-jr94-gj3h-c8rf / CVE-2026-26185).
- Concealed sensitive fields in revision history (GHSA-mvv8-v4jj-g47j / CVE-2026-39943).

### Acknowledgements

The CairnCMS codebase originated in Directus v10. Thanks to the Directus team and contributors for the work the project is built on.
