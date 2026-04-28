# Blackbox Tests

Integration tests that spin up a real CairnCMS API server and exercise REST and GraphQL endpoints end-to-end. ~9,000 tests across 6 supported database vendors.

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

This handles the build/deploy step automatically.

On systems with limited RAM (<8GB), limit parallelism:

```bash
TEST_DB=postgres pnpm test:blackbox -- --maxWorkers=2
```

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
