---
title: Running locally
description: "Set up a development environment for CairnCMS itself: clone, install, configure a database, bootstrap, and run the API and admin app against the local source."
sidebar:
  order: 2
---

This page is for contributors who want to run CairnCMS from the source tree, modify the code, and see their changes apply immediately. For running CairnCMS to use as a CMS, see [Quickstart](/docs/getting-started/quickstart/) instead.

## Prerequisites

- **Node.js 22 LTS** or newer. The platform targets Node 22 and runs CI against it.
- **pnpm 10+**. The repo pins `pnpm@10.13.1` as its `packageManager`. Use corepack (`corepack enable`) to pick up the pinned version automatically.
- **Docker and Docker Compose**, for the database and supporting services. The root `docker-compose.yml` provides every supported database vendor on local ports.
- **Git**, with a configured user and email. Commits must be signed off (`git commit -s`) per the [Developer Certificate of Origin](https://developercertificate.org/).

A few hundred MB of free RAM and disk space are also needed during dependency install and build.

## Clone and install

```bash
git clone https://github.com/CairnCMS/cairncms.git
cd cairncms
pnpm install
```

`pnpm install` walks the workspace and links every internal package against every other. The first install takes a few minutes.

After install, build the workspace once:

```bash
pnpm build
```

This compiles every workspace member except `docs/` in dependency order. Subsequent dev sessions only build the package you are actively working on (more on that below).

## Choose a database

The platform supports SQLite, PostgreSQL, MySQL, MariaDB, and others. For local development, two paths:

### SQLite (simplest)

No services to start. Set `DB_CLIENT=sqlite3` in your `.env` (covered below) and point `DB_FILENAME` at a local file. Good for quick iteration, exploring the platform, and running unit tests.

### A server vendor through Docker Compose

The root `docker-compose.yml` brings up every supported vendor on local ports. Start whichever you need:

```bash
# Postgres on port 5100
docker compose up -d postgres

# MySQL 8 on port 5101
docker compose up -d mysql

# MariaDB on port 5102
docker compose up -d maria
```

The compose file's header comment lists the full port and credential matrix. The exposed ports are in the `5xxx` range.
API integration tests provision separate containers with dynamically assigned ports.

The compose also defines `s3proxy`, an S3-compatible server on port `5106` (key `cairncms`, secret `miniosecret`), for exercising the S3 storage driver locally. Start it, then create a bucket with the AWS CLI (S3Proxy has no web console):

```bash
docker compose up -d --wait s3proxy

AWS_ACCESS_KEY_ID=cairncms AWS_SECRET_ACCESS_KEY=miniosecret \
  aws --endpoint-url http://localhost:5106 --region us-east-1 s3api create-bucket --bucket cairncms-local
```

Then point a storage location at it in your `.env`:

```
STORAGE_LOCATIONS="local,s3"
STORAGE_S3_DRIVER="s3"
STORAGE_S3_KEY="cairncms"
STORAGE_S3_SECRET="miniosecret"
STORAGE_S3_BUCKET="cairncms-local"
STORAGE_S3_REGION="us-east-1"
STORAGE_S3_ENDPOINT="http://localhost:5106"
STORAGE_S3_FORCE_PATH_STYLE="true"
```

For a setup that mirrors what most operators run in production, Postgres is the right choice. The local credentials are `postgres` / `secret` against the `cairncms` database on port `5100`.

## Configure the environment

Create `api/.env` with at minimum:

```bash
KEY=local-dev-key
SECRET=local-dev-secret

DB_CLIENT=pg
DB_HOST=localhost
DB_PORT=5100
DB_DATABASE=cairncms
DB_USER=postgres
DB_PASSWORD=secret

PUBLIC_URL=http://localhost:8055

ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=password
```

For SQLite, replace the `DB_*` block with:

```bash
DB_CLIENT=sqlite3
DB_FILENAME=./data.db
```

Relative paths in `api/.env` resolve against the API package's working directory, so `./data.db` lives at `api/data.db` when you run the dev server from the repo root with `pnpm --filter api run dev`. Use an absolute path if you want the file somewhere else.

`KEY` and `SECRET` can be any strings for local development; in production they need to be cryptographically random. `ADMIN_EMAIL` and `ADMIN_PASSWORD` create the initial admin account on first bootstrap.

The full configuration reference, including auth providers, mail, storage, cache, and the rest, is in [Configuration](/docs/manage/configuration/).

## Bootstrap and start

The API has a two-step lifecycle: bootstrap once to set up system tables, then run the dev server.

```bash
# From the repo root, run the API's CLI bootstrap once
pnpm --filter api run cli bootstrap

# Then start the dev server with hot reload
pnpm --filter api run dev
```

`pnpm --filter api run dev` runs `tsx watch` on `src/start.ts`, which restarts the server whenever you save a TypeScript file in `api/src/`. The server defaults to port `8055`.

The bootstrap step:

- Creates every `directus_*` system table.
- Applies all migrations.
- Creates the admin user from `ADMIN_EMAIL` and `ADMIN_PASSWORD` (only on first run).

Re-run bootstrap whenever you pull changes that add new migrations.

## Run the admin app

In a second terminal, start the Vue app:

```bash
pnpm --filter app run dev
```

This runs Vite on port `8080` by default and proxies API calls to `http://localhost:8055`. Open `http://localhost:8080/admin/` in a browser; the app loads with hot module replacement.

For most contributing work, both the api dev server and the app dev server need to be running. Keep them in two terminal panes.

## Tests

Run tests and lint independently:

- **Unit tests** (per-package, fast):

  ```bash
  pnpm test
  ```

  Runs the workspace unit tests and SDK type tests. API integration has a separate command. Most contributions need this
  to pass before review.

- **API integration tests**:

  ```bash
  # Build the application and record the inputs being tested
  pnpm test:integration:prepare

  # Run one suite on PostgreSQL (requires Docker)
  pnpm test:integration routes/auth/login.test.ts

  # Select a named case
  pnpm test:integration routes/auth/login.test.ts -t 'when correct credentials.*Admin User'

  # Run an ordinary SQLite suite without Docker
  pnpm test:integration --vendor sqlite3 routes/items/no-relation.test.ts

  # Run the full PostgreSQL suite and collect all failures
  pnpm test:integration --vendor postgres --collect-all
  ```

  Each file gets a fresh database and API process. Keep Docker running for server databases and suites that use Redis,
  SAML, or S3. The harness starts and cleans up its own services. Local runs stop on the first failure by default. Use
  `--collect-all` to continue or `--list` to inspect a selection without starting services.

  Repeat `pnpm test:integration:prepare` after changing application source, dependencies, or build configuration. The
  runner rejects stale builds. Test-only and documentation edits can reuse the build.

  Available vendors are `postgres`, `postgres10`, `mysql`, `mysql5`, `maria`, and `sqlite3`. Use `--vendor all` for all
  six. CI runs the complete matrix on `develop` pushes. See the
  [integration README](https://github.com/CairnCMS/cairncms/blob/develop/tests/integration/README.md) for adding suites
  and reading results.

- **Lint**:

  ```bash
  pnpm lint
  ```

  Runs ESLint across the workspace. Auto-fixable issues can be addressed with `pnpm lint --fix`.

## Common workflows

### Working on the API

Edit files in `api/src/`. The dev server restarts automatically on save. Most controllers, services, and middleware are reloadable; database migrations require a re-bootstrap if you add a new migration file under `api/src/database/migrations/`.

### Working on the admin app

Edit files in `app/src/`. Vite reloads modules in the browser on save. Vue components hot-replace; route or store changes occasionally need a full page reload.

### Working on a shared package

Packages under `packages/` are imported by api, app, and sdk through pnpm's symlinking, so source changes are visible immediately. Some packages need a build step to publish their compiled output:

```bash
# Rebuild a single package after editing it
pnpm --filter @cairncms/utils run build

# Or run its build in watch mode
pnpm --filter @cairncms/utils run dev
```

The api and app dev servers pick up the rebuilt output on their next reload.

### Working on the SDK

```bash
pnpm --filter @cairncms/sdk run dev
```

Watches `sdk/src/` and rebuilds on change. Local consumers (other workspace members or external projects linked with `pnpm link`) see the new build immediately.

## Resetting state

Local databases accumulate state quickly during development. To start fresh:

```bash
# SQLite (the file lives in api/, per the relative path in api/.env)
rm api/data.db
pnpm --filter api run cli bootstrap

# Postgres / MySQL / MariaDB through compose
docker compose down -v
docker compose up -d postgres
pnpm --filter api run cli bootstrap
```

`docker compose down -v` removes the named volumes that hold database state. The `up -d` brings the service back up empty.

## Troubleshooting

- **`pnpm install` fails on Node 24+** — the platform targets Node 22 LTS. If you must run on a newer version, expect
  occasional dependency-version mismatches; the lockfile is pinned against Node 22.
- **The api dev server fails to start with a database error** — the most common cause is the database not being up yet.
  `docker compose ps` shows the running services; `docker compose logs <service>` shows why something failed.
- **The admin app loads but says "API not reachable"** — check that the api dev server is running on `8055` and that
  `PUBLIC_URL` in `api/.env` matches the URL the app is making requests against.
- **An API integration test fails** — inspect the result directory printed by the command under
  `tests/integration/.artifacts/`. It retains test results and process logs. A startup failure should be diagnosed from
  those logs before rerunning.
- **Changes in a `packages/` library don't show up in the api or app** — the package may need a manual rebuild. Run
  `pnpm --filter <package> run build` and reload the dev server.

## Where to go next

- [Repository layout](/docs/contributing/repository-layout/) — the map of workspace members and where each piece of functionality lives.
- [Contributing overview](/docs/contributing/) — branching, the canonical `CONTRIBUTING.md` and `AI_POLICY.md` files, and review expectations.
- [Configuration](/docs/manage/configuration/) — every environment variable that the API reads.
- [Extensions](/docs/develop/extensions/) — building extensions, which is a different setup story (a separate package with its own dependencies).
