---
title: Repository layout
description: A map of the CairnCMS monorepo: which package holds the API, which holds the admin app, where the shared utilities live, and how the workspace fits together.
---

CairnCMS is a pnpm-managed monorepo. The published platform is composed of multiple packages that depend on each other internally, plus a few support packages (the SDK, the extension scaffolder, the storage drivers) that ship to npm independently. This page walks the top-level structure so new contributors know where to look.

## The workspace

`pnpm-workspace.yaml` declares the workspace members:

- `cairncms` — the umbrella package that publishes the `cairncms` CLI binary on npm.
- `api` — the API server.
- `app` — the admin app.
- `sdk` — the JavaScript client.
- `packages/*` — shared utilities, type definitions, the extensions SDK, the storage drivers, and supporting libraries.
- `tests/*` — the blackbox test suite.

Run `pnpm install` from the repo root to install dependencies for every workspace member. Cross-package imports (`@cairncms/utils` from inside `api/`, for example) resolve through pnpm's symlinking and reflect local source changes immediately.

## Top-level packages

### `cairncms/`

The umbrella package that ships to npm as `cairncms`. It is small by design: the entire job of this package is to register the `cairncms` CLI binary and delegate to `@cairncms/api`'s CLI runner.

The `cli.js` entrypoint reads its own `package.json`, exposes the version through `CAIRNCMS_PACKAGE_VERSION`, and imports `@cairncms/api/cli/run.js`. Operators run `cairncms bootstrap`, `cairncms start`, and the schema and config commands through this package.

This is also the package that gets installed globally with `npm install -g cairncms` for non-Docker deployments.

### `api/`

The API server. Holds the entire REST and GraphQL surface, the auth flow, the items service, the schema and migrations runner, the flow engine, the webhook dispatcher, the asset transformation pipeline, and the CLI command set. Most code in `api/src/` falls into one of these directories:

- **`controllers/`** — Express route handlers, one file per top-level path. The collection endpoints (`/items/<collection>`, `/users`, `/roles`, etc.) live here.
- **`services/`** — the business-logic layer. Each system collection has a service (`UsersService`, `RolesService`, `FilesService`, and so on). Controllers thin-call into services.
- **`auth/`** — login, refresh, providers (`local`, `oauth2`, `openid`, `ldap`, `saml`).
- **`database/`** — Knex setup, the migrations runner, system-data seeds (`directus_*` collections, fields, relations, app-access permissions), and per-vendor schema helpers.
- **`middleware/`** — Express middleware (authenticate, extract-token, sanitize-query, validate-batch, error-handler, respond, cache).
- **`utils/`** — query sanitizing, schema snapshot, config snapshot, JWT helpers, hash generation, and other cross-cutting helpers.
- **`cli/`** — the command implementations behind the `cairncms` binary (`bootstrap`, `start`, `database migrate`, `schema snapshot/apply`, `config snapshot/apply`, `users`, `roles`, `init`).
- **`controllers/graphql.ts`** and **`services/graphql/`** — the two GraphQL endpoints (`/graphql` and `/graphql/system`) and the schema builder.

The api package compiles to `api/dist/` and is consumed by `cairncms/cli.js` at runtime.

### `app/`

The Vue admin app. Loaded by users at `/admin/`, served by the API. Built with Vite. The relevant directories under `app/src/`:

- **`modules/`** — top-level modules (Content, User Directory, File Library, Insights, Settings, Activity Log). One module per directory.
- **`views/`** — the chrome around modules: navigation, login, error pages.
- **`components/`** — shared Vue components used across modules.
- **`composables/`** — Vue composables (Pinia stores, hooks, utilities).
- **`stores/`** — Pinia stores for cross-component state (current user, settings, presets, permissions).
- **`interfaces/`**, **`displays/`**, **`layouts/`**, **`panels/`** — built-in extensions of each type, shipped as part of the app rather than as separate npm packages.

The app builds to `app/dist/`, which the API serves at `/admin/`.

### `sdk/`

The official JavaScript client published as `@cairncms/sdk`. Documented in detail at [SDK](/docs/api/sdk/). The directory holds:

- **`src/client.ts`** — the base `createCairnCMS()` factory.
- **`src/auth/`** — the `authentication()` and `staticToken()` composables.
- **`src/rest/`** — the `rest()` composable plus the command catalog (one file per system collection plus `items`, `assets`, `server`, `schema`, `utils`).
- **`src/graphql/`** — the `graphql()` composable.
- **`src/types/`** — TypeScript types for the schema-typed client.
- **`src/utils/`** — the `request()` helper, URL construction, etc.
- **`tests/`** — unit and integration tests.

## `packages/`

The internal shared packages. None of these are application code; they are the libraries the api, app, and sdk depend on. Each is independently versioned and most are independently publishable.

- **`@cairncms/types`** — TypeScript type definitions used by every workspace member. Anything that travels between api, app, and sdk has a type defined here.
- **`@cairncms/constants`** — shared constants (extension types, geometry formats, default values, the public role sentinel).
- **`@cairncms/exceptions`** — the exception classes the API throws. Imported by api/src and re-exported from `api/src/exceptions/`.
- **`@cairncms/utils`** — string and JSON helpers shared across packages. Includes the array helper, the JSON parser with date revival, and the `readableStreamToString` utility used by the multipart handler.
- **`@cairncms/format-title`** — the title-case formatter applied to default file titles, collection names, and field names.
- **`@cairncms/composables`** — shared Vue composables that were extracted from the app for reuse in extensions.
- **`@cairncms/schema`** — the platform's understanding of database schemas. Wraps Knex's schema inspector with type-safe per-vendor helpers.
- **`@cairncms/specs`** — the OpenAPI base spec (`packages/specs/src/openapi.yaml`) and the dynamic generator that pairs it with the running schema.
- **`@cairncms/extensions-sdk`** — the developer-facing SDK for building extensions. Ships the `define*` helpers (`defineInterface`, `defineHook`, etc.) and the `cairncms-extension` build CLI.
- **`@cairncms/create-cairncms-extension`** — the scaffolder reachable as `npm init cairncms-extension`. Generates a starter extension package.
- **`@cairncms/update-check`** — the version-check helper invoked at startup.
- **`@cairncms/storage`** and the per-driver storage packages (`@cairncms/storage-driver-local`, `@cairncms/storage-driver-s3`, `@cairncms/storage-driver-gcs`, `@cairncms/storage-driver-azure`, `@cairncms/storage-driver-cloudinary`). The base package defines the storage interface; each driver implements it.

The `packages/dist/` directory is build output for the workspace and is gitignored.

## `tests/`

End-to-end tests that exercise a running CairnCMS instance against real databases.

- **`tests/blackbox/`** — the blackbox suite. Spins up the supporting services (Redis, MinIO + MinIO client, a SAML test IdP) and an optional database container via `tests/blackbox/docker-compose.yml`, runs `cairncms bootstrap` against the chosen vendor, then exercises the API end-to-end. SQLite does not run in a container; the SQLite path uses a local file and only the supporting services come up. Other vendors (Postgres, Postgres 10, MySQL, MySQL 5, MariaDB) bring up their database container alongside the supporting services. Pick a vendor with `TEST_DB=postgres pnpm test:blackbox` (or `sqlite3`, `mysql`, `maria`, etc.).

The blackbox suite is the highest-coverage layer of CairnCMS testing. CI runs the SQLite-only path on every PR (the `Blackbox Tests` workflow at `.github/workflows/blackbox-pr.yml`); the full vendor matrix (`sqlite3`, `postgres`, `postgres10`, `mysql`, `mysql5`, `maria`) runs on pushes to `main` (`.github/workflows/blackbox-main.yml`). Locally, run at least the SQLite path before submitting changes that touch query semantics, schema operations, or the auth flow; run additional vendors when changes affect SQL generation. See [Running locally / Tests](/docs/contributing/running-locally/#tests) for the local-run command.

## Documentation

Two trees:

- **`docs/`** — the new docs site, written in Markdown for Starlight. This is what publishes to the docs site. The structure mirrors the navigation: `docs/getting-started/`, `docs/guides/`, `docs/develop/`, `docs/manage/`, `docs/api/`, `docs/contributing/`.
- **`docs-legacy/`** — the upstream Directus v10 documentation, preserved during the migration. Files are migrated into `docs/` and removed from `docs-legacy/` only after the new content lands. This tree is not published anywhere; it is a reference for the migration.

## Container and deployment files

- **`Dockerfile`** — the multi-stage build that produces the `cairncms/cairncms` image.
- **`docker-compose.yml`** — local-dev stack at the repo root (Postgres, Redis, CairnCMS pointed at the local source). Uses ports `5xxx` so it can run alongside the blackbox stack.
- **`tests/blackbox/docker-compose.yml`** — the blackbox stack on ports `6xxx`. Lives under `tests/` rather than at the repo root for that reason.

Both compose files are intended to run from a developer machine. Production deployments build their own compose or Kubernetes manifests around the published image; see [Deployment](/docs/manage/deployment/) for the operator-facing reference.

## Working across packages

The pnpm workspace is the glue. A handful of patterns are worth knowing:

- **Cross-package imports use the package name**, not relative paths. `import { ... } from '@cairncms/utils'` works inside any workspace member; pnpm resolves it to the local `packages/utils/` source automatically.
- **Build order is implicit**. `pnpm build` from the repo root builds every workspace member in dependency order.
- **Running just one package**'s build, test, or lint is `pnpm --filter <package-name> <script>`. For example, `pnpm --filter api test` runs the api unit tests; `pnpm --filter @cairncms/sdk build` rebuilds the SDK.
- **Adding a dependency** to one workspace member is `pnpm --filter <package-name> add <dep>`. Adding it to the root (a tooling dep, for example) is `pnpm add -w <dep>`.

The pattern is consistent enough that most workflows fit "filter then run." Fall back to `cd <package> && pnpm <script>` if the filter syntax is awkward in a scripted context.

## Where to go next

- [Running locally](/docs/contributing/running-locally/) — set up a development environment and run the platform against the local source.
- [Pull request process](/docs/contributing/pull-request-process/) — branching conventions, PR template, AI disclosure, and review expectations.
- [Extensions](/docs/develop/extensions/) — how the `@cairncms/extensions-sdk` and `@cairncms/create-cairncms-extension` packages described above fit into the operator-facing extension authoring story.
