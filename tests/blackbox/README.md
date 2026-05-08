# Blackbox Tests

Integration tests that spin up a real CairnCMS API server and exercise REST and GraphQL endpoints end-to-end.

## Important: Two Docker Compose Files

This repo has two separate `docker-compose.yml` files with different purposes:

- **`docker-compose.yml`** (repo root) — for **local development**. Uses ports `5xxx`.
- **`tests/blackbox/docker-compose.yml`** (this folder) — for **blackbox testing**. Uses ports `6xxx`.

They use different ports so they can run side by side without conflicts.

## CI

Blackbox tests run automatically in GitHub Actions on every push to `main`. The CI matrix tests all 6 supported vendors in parallel: SQLite3, Postgres, Postgres10, MySQL, MySQL5, and MariaDB.

## Running Tests Locally

### 1. Start services

Start the database and supporting services using the **blackbox** compose file:

```bash
docker compose -f tests/blackbox/docker-compose.yml up postgres auth-saml redis minio minio-mc -d
```

For SQLite (no database container needed):

```bash
docker compose -f tests/blackbox/docker-compose.yml up auth-saml redis minio minio-mc -d
```

### 2. Run tests

From the **repo root** (not this folder):

```bash
TEST_DB=postgres pnpm test:blackbox
```

This runs blackbox tests against the currently built server code.

On systems with limited RAM (<8GB), limit parallelism:

```bash
TEST_DB=postgres pnpm test:blackbox -- --maxWorkers=2
```

#### Important: blackbox runs against whatever is already in `dist/`

`pnpm test:blackbox` does NOT rebuild before running. It deploys what each package has already built. If you have changed source in `api/`, `app/`, or any other package since the last build, the deploy will copy stale compiled output and tests will run against the old behavior. Rebuild first when iterating on package source:

```bash
pnpm build && TEST_DB=postgres pnpm test:blackbox
```

#### Important: blackbox does not exercise the published image's module resolution

The blackbox suite runs the deployed `dist/` code, but inside an environment that differs from the published Docker image. Two mechanisms drive the divergence:

1. `tests/blackbox/common/config.ts:66` spreads `...process.env` into each vendor's env block.
2. `tests/blackbox/setup/setup.ts:42` (bootstrap) and `tests/blackbox/setup/setup.ts:58` (server start) both pass that merged env to the spawned `node` process.

When blackbox is invoked via `pnpm test:blackbox`, pnpm sets `NODE_PATH=<repo>/node_modules/.pnpm/node_modules` for the script run, and that `NODE_PATH` flows through into the spawned bootstrap. The published Docker image runs `node --no-node-snapshot /cairncms/cli.js bootstrap` directly with no `NODE_PATH`.

Practical consequence: the suite can pass even when the published image has a real module-resolution bug. The workspace's flat virtual store provides a fallback resolution path that the container does not have. If you are debugging "this works in CI but breaks in production," reproduce against the Docker image directly (`docker build` and `docker run`) instead of relying on a green blackbox run as evidence that runtime module resolution is healthy.

### Testing a specific database

Provide a csv of database drivers in the `TEST_DB` environment variable:

```bash
TEST_DB=postgres,sqlite3 pnpm test:blackbox
```

### Supported vendors

- `sqlite3`
- `postgres`
- `postgres10`
- `mysql`
- `mysql5`
- `maria`

### Saving server logs

Prepend `TEST_SAVE_LOGS=trace` to capture server logs to `server-log-*` files in this folder:

```bash
TEST_SAVE_LOGS=trace TEST_DB=postgres pnpm test:blackbox
```

### Using an existing CairnCMS instance

To test against an already-running instance instead of spawning a new one:

```bash
TEST_DB=postgres TEST_LOCAL=true pnpm test:blackbox
```

This uses `127.0.0.1:8055` as the URL. Make sure your instance is connected to the test database container from the docker-compose in this folder.

## Adding a new test file

**Register every new blackbox test file in `setup/sequentialTests.js`.** If you skip this step, filtered runs can hang before the first test starts, and full-suite ordering of your file is not guaranteed.

Add the path under either:

- `before` — runs in the early sequence (typical for new route contract tests; pick a position near similar files)
- `after` — runs late, used for files that must execute serially after everything else

The framework runs test files through an ordering barrier defined in `setup/customEnvironment.ts`: each file's setup polls a flow-tracking endpoint and waits for prior files to mark themselves complete before its tests start.

Example:

```javascript
// tests/blackbox/setup/sequentialTests.js
exports.list = {
    before: [
        { testFilePath: '/common/seed-database.test.ts' },
        { testFilePath: '/common/common.test.ts' },
        { testFilePath: '/routes/schema/schema.test.ts' },
        { testFilePath: '/routes/your-feature/your-feature.test.ts' }, // ← add here
        // ...
    ],
};
```

If you skip registration, the framework defaults the file's index to `before.length`, meaning it waits for that many other files to finish. In a full-suite run this works because enough other files do finish; in a path-filtered run it deadlocks.

### Single-file runs are not supported by default

`jest path/to/your.test.ts` (or `pnpm test:blackbox -- routes/your-feature`) **will hang silently after `globalSetup`** — even for files registered in `before` or `after` because the file's expected ordering position can never be reached when only one file is in the queue.

For local iteration on a single file, temporarily set the `only` array in `setup/sequentialTests.js`:

```javascript
only: [
    { testFilePath: '/routes/your-feature/your-feature.test.ts' },
],
```

This bypasses the ordering barrier (the file becomes index 0). Revert `only` to an empty array before committing, or CI will run only that one file.

### Verifying a new test file

Run the full blackbox suite for one vendor locally and confirm both that your file passes and that the suite as a whole still passes:

```bash
pnpm build && TEST_DB=postgres pnpm test:blackbox -- --runInBand
```

CI runs the full vendor matrix automatically on push to `main`. `--runInBand` matches the CI invocation (see `.github/workflows/blackbox-main.yml`) and avoids worker port collisions.
