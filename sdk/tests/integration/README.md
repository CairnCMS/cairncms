# Integration tests

Runtime integration tests for `@cairncms/sdk`. Unlike `sdk/tests/*.test-d.ts`
(type-level assertions), these boot a real CairnCMS API, apply a test fixture,
and exercise SDK methods against live HTTP.

## Running

```bash
pnpm --filter @cairncms/sdk test:integration
```

The harness is **fully self-contained**. No prep: no `docker compose`, no
manually-running API. Each run:

1. Picks an unused TCP port
2. Creates a unique temp dir at `/tmp/cairncms-sdk-integration-<uuid>/`
3. Bootstraps a fresh SQLite DB at `<temp>/directus.db` (migrations + admin user)
4. Spawns an API subprocess (tsx, not the built dist — no build step required)
5. Waits for `/server/ping`
6. Creates three fixture collections via raw HTTP
7. Grants public read on one of them
8. Seeds rows directly via knex (bypassing the SDK under test)
9. Runs all tests sequentially
10. Kills the API, removes the temp dir

Takes ~20 seconds per run. No Docker, no Postgres, no external state.

## Debugging

Set `SDK_IT_DEBUG=1` to stream API subprocess stdout/stderr to the test runner:

```bash
SDK_IT_DEBUG=1 pnpm --filter @cairncms/sdk test:integration
```

## Fixture

Three collections, all with UUID primary keys:

- `sdk_test_categories` (admin-only): 3 seeded rows (electronics, books, garden)
- `sdk_test_items` (admin-only): 10 seeded rows with m2o `category` relation + scalar `value`
- `sdk_test_public_items` (public-readable): 2 seeded rows

Fixed UUIDs are defined in `helpers/constants.ts` so test assertions can reference
known ids without "find first item" fragility.

The m2o from `sdk_test_items.category` to `sdk_test_categories` is a **logical
relation** (Directus metadata only, no DB-level FK). SQLite doesn't support
`ALTER TABLE ADD CONSTRAINT FOREIGN KEY`, so `/relations` is called with
`schema: null`. Filter-DSL joins still work — they resolve through the
`directus_relations` metadata, not the DB FK.

## Layering (why things are where they are)

- `setup.ts` — vitest globalSetup. Owns the full lifecycle; tries + catches so
  failures don't leak API subprocesses or temp dirs.
- `helpers/constants.ts` — collection names, seeded UUIDs, env var keys tests
  read.
- `helpers/temp-dir.ts` — unique per-run temp dir.
- `helpers/api-env.ts` — hermetic env for the API subprocess. Ignores
  `api/.env`; sets `CONFIG_PATH` to a non-existent file to prevent Directus
  from loading any local `.env` at runtime.
- `helpers/spawn-api.ts` — bootstrap runner, subprocess spawn, readiness poll,
  clean kill (SIGTERM → 5s → SIGKILL).
- `helpers/setup-http.ts` — admin login + `createCollection`/`createField`/
  `createRelation`/`grantPublicRead`. Raw `fetch` only; never uses the SDK.
- `helpers/seed.ts` — knex-driven direct DB insert of fixture rows.

## Vitest `define` for `__SYSTEM_COLLECTION_NAMES__`

`sdk/src/rest/utils/is-system-collection.ts` references a build-time placeholder
that `tsup.config.js` replaces via `esbuild-plugin-replace`. Vitest runs SDK
source directly (not the bundled `dist/`), so the placeholder is undefined at
test time. `vitest.integration.config.ts` declares it via `define:`.

Both configs read from a single source of truth at
`sdk/config/system-collection-names.js`. Update that file if the CairnCMS API
adds or removes a system collection; don't duplicate the list anywhere else.

## If you add a new test

Tests consume `SDK_IT_URL`, `SDK_IT_ADMIN_EMAIL`, `SDK_IT_ADMIN_PASSWORD` from
`process.env` (published by globalSetup). Each test should log in via the SDK
— don't share tokens across tests, that's part of what's under test.
