# Changelog

All notable changes to CairnCMS are documented in this file. Releases are listed in reverse chronological order. Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-07-12

### Breaking Changes

- Remove host Node and OS details from `/server/info` (REST and GraphQL). Admin callers no longer receive the `node` and `os` blocks, and GraphQL queries for those fields now error. The product version is still available to admins as `cairncms.version`. If your tooling read host metrics from this endpoint, source them from your host or infrastructure layer instead. (#136)
- Store replacement file bytes under a fresh `filename_disk` (`<id>-<nonce><ext>`) while new uploads keep the initial `<id><ext>` name. This lets failed replacements preserve the existing row and bytes. Tooling that constructs storage object names from file IDs should read the current `filename_disk` from `/files/<id>` or serve bytes through `/assets/<id>` instead. (#137)

### New Features

- Add expand/collapse for collection items in the data model. (#135)
- Add `FILES_MAX_UPLOAD_SIZE` and `FILES_MIME_TYPE_ALLOW_LIST` upload limits. (#137)
- Add declared extension settings and their management surface. (#134)
- Add the item-view extension type for split panes in the item editor. (#147)

### Fixes & Improvements

- Declare axios as a runtime dependency of the composables package. (#129)
- Localize the empty-text fallback in the presentation-notice interface. (#131)
- Fix the metric panel's abbreviate-value option defaulting to on. (#132)
- Improve custom options-component detection for setup-based Vue components. (#133)
- Harden file upload and replacement failure handling. (#137)
- Markdown headings rendered in the app no longer get generated DOM IDs. (#138)
- Translate field names in the collection folder dialog. (#139)
- Bump @sindresorhus/slugify to 2.2.1. (#140)
- Optimize countDistinct aggregation on primary key fields. (#141)
- Segment the response cache key by authorization context. (#144)
- Deny the IPv6 unspecified address in outbound-request IP validation. (#145)
- Bump form-data to 4.0.6, 3.0.5, and 2.5.6. (#146)
- Bump vite to 6.4.3. (#148)
- Bump undici to 6.27.0. (#149)
- Bump nodemailer to 9.0.1. (#150)
- Override tmp@0.0.33 to 0.2.7. (#151)
- Polish the extensions page detail dialog and settings menu. (#152)

## [1.2.0] - 2026-06-18

### Breaking Changes

- Update the Vue baseline to 3.5 and migrate the extensions SDK build to `@vitejs/plugin-vue`. Rebuild app extensions against the new baseline. (PR #120)

### New Features

- Add a sandboxed runtime for confined server extensions, covering operations, endpoints, hooks, and bundles. (PR #115)
- Show confined extension status, declared capabilities, and the sandbox posture in the admin extensions view. (PR #115)
- Add a full-screen toggle to collection pages. (PR #113)

### Fixes & Improvements

- Fix an empty preview box when batch-editing files. (PR #114)
- Fix inviting users from the user directory. (PR #114)
- Fix list panel edits for system collections. (PR #114)
- Restyle the admin app with a neutral theme. (PR #113)
- Fix default value handling in the raw editor and exposed batch editing state to interface components. (PR #116)
- Reduce spurious column alters during field updates. (PR #117)
- Fix unknown filter and sort fields returning internal errors. (PR #118)
- Fix automatic image format conversion destroying transparency. (PR #119)
- Isolate app extension loading so one failing extension cannot break the others. (PR #115)
- Fix shared-dependency externalization for app extensions in production builds. (PR #115)
- Escape line and paragraph separators when generating the extensions entrypoint. (PR #121)

## [1.1.0] - 2026-05-28

### New Features

- Add a Cache toggle for webhook flows. (#93)
- Accept multipart schema-diff uploads on `/schema/apply`. (#94)
- Add an optional pressure-based rate limiter. (#95)
- Add folder navigation to file and image selectors. (#98)
- Add Kanban layout for grouped collection views. (#99)
- Add bar chart, line chart, pie chart, and meter panels to Insights. (#100)
- Enable `.cjs` and `.mjs` custom migration files. (#89)
- Build new API extensions as ESM by default. (#101)

### Fixes & Improvements

- Fix admin UI edge cases. (#74, #103, #104, #105, #107)
- Fix OAuth2 and OpenID refresh-token persistence for existing SSO users. (#75)
- Clear cached item responses after permission changes. (#77)
- Apply relational field presets when creating nested items. (#79)
- Wait for field metadata before rendering form fields. (#80)
- Resolve aliased fields in display templates and CSV exports. (#82)
- Accept `offset=0` in sanitized REST queries. (#84)
- Stop numeric search from matching hex, binary, exponent, and infinity values. (#85)
- Close the database connection after bootstrap completes. (#87)
- Stop asset preset resolution from changing the input transform array. (#90)
- Clean up extension build config loading, Rollup warnings, and shared package metadata. (#91, #92)
- Stop publishing test files in API and workspace package builds. (#102)
- Fix Kanban drag-and-drop when no sort field is configured. (#106)
- Prevent partial relation PATCH requests from crashing the API. (#110)
- Keep `format: auto` asset preset negotiation isolated per request. (#111)
- Update dependencies. (#108)
- Return the same forbidden response for invalid invite-accept tokens and account states. (#109)

## [1.0.0] - 2026-05-19

### Highlights

First public release of CairnCMS. 🎉

CairnCMS 1.0.0 is a GPLv3 fork of Directus v10. The data model, REST and GraphQL APIs, auth flow, permissions, and admin app remain broadly compatible with Directus v10 so existing Directus v10 frontends and integrations should require little or no change.

This release includes modernization, a new look and features, as well as a broad security-hardening pass.

### Project Identity And Packaging

- **License.** GPLv3, replacing BUSL-1.1.
- **Telemetry removed.** No phone-home and no opt-out flag is needed.
- **Package scope.** First-party packages publish under `@cairncms/*`.
- **CLI binaries.** `cairncms` replaces `directus`; the extension CLI is `cairncms-extension`.
- **Vendored format-title.** `@cairncms/format-title` replaces `@directus/format-title`.
- **Local TypeScript config.** Replaces the previous `@directus/tsconfig` shared package.
- **First-party Mapbox styles.** Default basemaps now use Mapbox stock styles, removing the dependency on Directus-owned Mapbox style UUIDs.
- **Rebranded admin theme.** New brand identity throughout the admin app.

### Runtime And Compatibility

- **Node 22 baseline.** Minimum Node 22.0.0. (Node 20 is EOL)
- **pnpm 10.x baseline.** Minimum pnpm 10.0.0.
- **Supported database vendors in CI.** SQLite, PostgreSQL, MySQL, and MariaDB.
- **Vendors dropped from CI.** Oracle, Microsoft SQL Server, and CockroachDB still work in code but are no longer covered by automated tests.

### New In CairnCMS

- **Config-as-code.** Roles and permissions can be exported to and applied from a versioned YAML directory.
- **`cairncms init` scaffold.** `npx cairncms init <project>` generates a self-contained Docker Compose project with admin credentials, `.env`, and a starter README.
- **Public-role sentinel.** The unauthenticated public role is represented by a reserved UUID row instead of `NULL`, which simplifies permission uniqueness and removes duplicate-permission merging behavior.
- **First-party JavaScript SDK.** `@cairncms/sdk` is a composable REST and GraphQL client vendored from `@directus/sdk`, with `createCairnCMS` and `CairnCMSClient` as the CairnCMS-facing names.
- **Official Docker images.** Multi-arch images publish to Docker Hub at `cairncms/cairncms` and GHCR at `ghcr.io/cairncms/cairncms`.
- **Documentation overhaul.** Documentation was rewritten end-to-end into Getting started, Guides, Develop, Manage, API reference, and Contributing sections.

### Breaking Changes

- **Run Script capability narrowed.** The `exec` flow operation now runs in an `isolated-vm` sandbox with no `require()` or host APIs. `FLOWS_EXEC_ALLOWED_MODULES` is removed; pre-1.0 flows that loaded modules need to be rewritten.
- **Legacy webhooks removed.** The Settings > Webhooks page and `directus_webhooks` collection are gone. Flows are the supported path. Existing records are not auto-migrated. The removal migration logs them at WARN level for manual recreation.

### Migrating From Directus 10

These are the changes operators coming from Directus 10 need to account for. Anything not listed here is preserved as-is.

- **Refresh-token cookie name.** `cairncms_refresh_token` replaces `directus_refresh_token`. Set `REFRESH_TOKEN_COOKIE_NAME=directus_refresh_token` only if you need compatibility with existing Directus 10 browser cookies; preserving active sessions also requires valid session records and the same `SECRET`.
- **Messenger namespace.** Redis messenger channels now default to `cairncms` instead of `directus`. If you run a mixed Directus/CairnCMS Redis-messenger deployment during migration, set `MESSENGER_NAMESPACE=directus`.
- **`/server/info` payload.** The top-level `directus` key is now `cairncms`. Update consumers of `response.data.directus.version`.
- **SDK factory and client type.** `createCairnCMS` replaces `createDirectus`; `CairnCMSClient` replaces `DirectusClient`. Schema-mirror types and command names are unchanged.
- **Docker paths.** Container working directory and default storage paths now live under `/cairncms` instead of `/directus`. Update bind mounts. Base image: `node:22-alpine`.
- **Database table names preserved.** `directus_users`, `directus_roles`, and the rest of the system tables keep their names. GraphQL system schema names and OpenAPI identifiers derived from those tables are also preserved.

### Coming From Directus 11

Directus 11 projects can usually reuse their application tables and content with CairnCMS because CairnCMS exposes collections through REST, GraphQL, files, auth, permissions, flows, and the admin app.

Start with the database schema and content you control. Then recreate or review CairnCMS system configuration in the admin app. Pay particular attention to roles and permissions, because Directus 11 stores access rules through policies and additive permission aggregation while CairnCMS follows the Directus 10 role-permission model.

Review flows, dashboards, presets, extensions, and Directus 11-specific features before relying on them in CairnCMS. Treat application data as the portable part and system configuration as a migration step.

### Security Hardening

This release includes a broad security pass across inherited Directus surfaces as well as CairnCMS-specific changes. The most important changes are:

- Auth surfaces avoid account-state disclosure where unauthenticated callers could distinguish suspended, invited, or unknown accounts.
- SSO redirects are constrained to safe local paths and parser-bypass regressions are covered.
- Server-side file imports validate outbound IPs at connection time and block loopback, host-interface, and metadata endpoints by default.
- Read-derived query features cannot be used as oracles for unread or concealed fields, including search, sort, group, aliases, and value-derived aggregates.
- Flow revisions redact known secret-bearing keys and values propagated from those keys into later operation options.
- First-party admin surfaces no longer put bearer tokens in generated asset or export URLs.
- GraphQL introspection-off mode also gates SDL export surfaces.

### Fixes

- Fixed date-only fields shifting by one day in non-UTC timezones.
- Restored default `DB_CLIENT=sqlite3` bootstrap in the published image.
- Returned controlled errors for malformed inputs on `/auth/password/reset` and `/utils/hash/verify`.
- Rejected unknown sort field names before SQL generation.
- Rejected non-object filter query inputs before recursive parsing.

<details>
<summary>Detailed advisory coverage</summary>

- Removed CORS origin fallback to a permissive wildcard. `CORS_ENABLED=true` now requires an explicit `CORS_ORIGIN`.
- Gated OAuth2 and OpenID Connect state cookies on `REFRESH_TOKEN_COOKIE_SECURE`.
- Multiple rounds of dependency updates resolving published CVEs.
- Replaced `vm2` with `isolated-vm` in the Run Script flow operation.
- Redacted tokens in flow logs (GHSA-f24x-rm6g-3w5v / CVE-2025-53886).
- Send password reset email to the stored address rather than the supplied input (GHSA-qw9g-7549-7wg5 / CVE-2024-27295).
- Collapsed suspended-user login and refresh errors into invalid credentials (GHSA-jgf4-vwc3-r46v / CVE-2024-39896).
- Excluded `/auth` responses from the response cache (GHSA-cff8-x7jv-4fm8 / CVE-2024-45596).
- Sanitized condition operation validation errors in flow responses (GHSA-fm3h-p9wm-h74h / CVE-2025-30353).
- Added `Cross-Origin-Opener-Policy` header to `/auth` routes (GHSA-8m32-p958-jg99 / CVE-2026-35408).
- Stripped server-controlled fields from file metadata writes (GHSA-393c-p46r-7c95 / CVE-2026-39942).
- Canonicalized IPv4-mapped IPv6 addresses before deny-list check in file imports (GHSA-wv3h-5fx7-966h / CVE-2026-35409).
- Memoized GraphQL `server_health` resolver per request (GHSA-6q22-g298-grjh / CVE-2026-35441).
- Masked concealed fields in aggregate query results (GHSA-38hg-ww64-rrwc / CVE-2026-35442).
- Removed CairnCMS version string from unauthenticated admin bundle (GHSA-5mhg-wv8w-p59j / CVE-2024-27296).
- Validated post-SSO redirect target in OAuth2 and OpenID login flows (GHSA-fr3w-2p22-6w7p / CVE-2024-28239).
- Validated post-SSO redirect target in SAML login flow (GHSA-3573-4c68-g8cc / CVE-2026-22032).
- Canonicalized post-SSO redirect targets to local paths across SSO login flows (GHSA-3573-4c68-g8cc / CVE-2026-22032, GHSA-fr3w-2p22-6w7p / CVE-2024-28239).
- Moved outbound HTTP IP validation to connection time (GHSA-8p72-rcq4-h6pw / CVE-2024-39699).
- Restricted `_in` / `_nin` filter operators with empty arrays (GHSA-hxgm-ghmv-xjjm).
- Masked concealed fields routed through query aliases (GHSA-p8v3-m643-4xqx / CVE-2024-34708).
- Deduplicated GraphQL aggregate field selections (GHSA-7hmh-pfrp-vcx4 / CVE-2024-39895).
- Validated share role and target share authority on create and update (GHSA-pmf4-v838-29hg / CVE-2025-24353).
- Extended outbound IP deny-list to the full loopback range (GHSA-68g8-c275-xf2m / CVE-2024-46990).
- Validated preset ownership on create and update (GHSA-3fff-gqw3-vj86 / CVE-2024-6534).
- Redacted `access_token` query parameter from request logs (GHSA-vw58-ph65-6rxp / CVE-2024-47822).
- Scoped the search query parameter to fields the caller is permitted to read (GHSA-7wq3-jr35-275c / CVE-2025-30352).
- Avoided opening storage read streams for asset `HEAD` requests (GHSA-rv78-qqrq-73m5 / CVE-2025-30350).
- Validated asset transform args before opening the source stream (GHSA-j8xj-7jff-46mx / CVE-2025-30225).
- Removed version string from OpenAPI spec responses (GHSA-rmjh-cf9q-pv7q / CVE-2025-53887).
- Required authentication and target collection/item read for manual flow triggers (GHSA-7cvf-pxgp-42fc / CVE-2025-53889).
- Cleaned the `fields` array on permissions for deleted fields (GHSA-9x5g-62gj-wqf2 / CVE-2025-64746).
- Excluded concealed fields from the search query parameter (GHSA-8jpw-gpr4-8cmh / CVE-2025-64748).
- Closed user-enumeration on the password reset request endpoint (GHSA-jr94-gj3h-c8rf / CVE-2026-26185).
- Concealed sensitive fields in revision history (GHSA-mvv8-v4jj-g47j / CVE-2026-39943).
- Added parser-bypass regression coverage for SSO redirect validation (GHSA-cf45-hxwj-4cfj / CVE-2026-35410).
- Gated GraphQL SDL specs on `GRAPHQL_INTROSPECTION` (GHSA-wxwm-3fxv-mrvx / CVE-2026-35413).
- Deduplicated GraphQL read resolver invocations within a request (GHSA-ph52-67fq-75wj / CVE-2026-35441).
- Removed access tokens from admin asset URL generation (GHSA-2ccr-g2rv-h677 / CVE-2024-28238).
- Closed DOM XSS in layout option template inputs (GHSA-9qrm-48qf-r2rw / CVE-2024-6533).
- Expanded sensitive-key coverage in flow log redaction.
- Returned controlled errors for malformed inputs on `/auth/password/reset` and `/utils/hash/verify`.
- Set `X-Content-Type-Options: nosniff` on all responses.
- Removed stale `super_admin_token` parameter from the `/server/info` spec.
- Rejected value-deriving aggregate operations on concealed fields at the query layer.
- Scoped metadata `filter_count` search to fields the caller is permitted to read.
- Send user invites to the stored account email rather than the supplied input.
- Redacted secrets from prior step outputs when persisting flow revisions.
- Removed access tokens from admin export URLs.
- Required field-read permission for sort and group query operands.
- Rejected sort and group on concealed fields at the query layer.

</details>

### Acknowledgements

The CairnCMS codebase originated in Directus v10. Thanks to the Directus team and contributors for the work the project is built on.
