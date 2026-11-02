# API integration tests

These tests exercise the compiled API with a fresh database and API process for each test file. You can run a single
case, a suite, or all suites across nine engine lines from four database vendors.

## Run tests

Use Node.js 22 and the repository's pinned pnpm version. PostgreSQL 18 is the default and requires a running Docker
daemon and the Docker CLI. The harness starts and stops its own containers.

Run these commands from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm test:integration:prepare
pnpm test:integration routes/auth/login.test.ts
```

Preparation builds the API and its workspace dependencies, the app, and the SDK. Repeat it after changing application
source, dependencies, or build configuration. Test-only and documentation edits can reuse the build. The runner rejects
a missing or stale build with instructions to rebuild.

```bash
# Select a case by its full name using a regular expression.
pnpm test:integration routes/auth/login.test.ts -t 'when correct credentials.*Admin User'

# List matching cases without building or starting services.
pnpm test:integration routes/auth/login.test.ts --list

# Run this SQLite suite without Docker.
pnpm test:integration --vendor sqlite3 routes/items/no-relation.test.ts

# Run every suite on all vendors and collect all failures.
pnpm test:integration --vendor all --collect-all
```

Each `--vendor` value selects one engine line, called a lane. Each vendor has a lane for its oldest and newest supported
line. `postgres10` and `mysql5` also cover the remaining compatibility code for older engines. Supported lines between
the oldest and newest, such as PostgreSQL 16 and 17, have no lane of their own. They rely on the dialect SQL being the
same across those lines, so a defect specific to one of them can pass these tests.

| Lane         | Engine                                |
| ------------ | ------------------------------------- |
| `sqlite3`    | SQLite                                |
| `postgres18` | PostgreSQL 18 / PostGIS 3.6 (default) |
| `postgres15` | PostgreSQL 15                         |
| `postgres10` | PostgreSQL 10 / PostGIS 3.2           |
| `mysql97`    | MySQL 9.7                             |
| `mysql84`    | MySQL 8.4                             |
| `mysql5`     | MySQL 5.7                             |
| `maria123`   | MariaDB 12.3                          |
| `maria1011`  | MariaDB 10.11                         |

Select several lanes with a comma-separated list, or select one with `TEST_DB`. `sqlite3` runs without Docker, but
SQLite suites that use Redis, SAML, or S3 still need it.

Local runs stop on the first failure by default. Add `--collect-all` to continue, `--workers 2` to run ordinary files in
parallel, or `--verbose` to show individual results. Load suites run exclusively within an invocation. CI runs full
vendor suites and collects all failures.

## Add a suite

Add a `*.test.ts` file under `tests/integration`. Files are discovered automatically. For example, a file under
`routes/server/` can use:

```ts
import { expect } from 'vitest';
import { apiTest as test } from '../../fixtures/environment';
import request from '../../fixtures/request';
import { initializeFixtures } from '../../harness/fixture-setup.mjs';

initializeFixtures();

test('answers a health request', async ({ api }) => {
	const response = await request(api.url).get('/server/health').expect(200);
	expect(response.body.status).toBe('ok');
});
```

Choose the fixture that supplies your prerequisites:

| Fixture                                                                                                            | Provides                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| [`apiTest`](fixtures/environment.ts)                                                                               | An API process and fresh database per file.                                      |
| [`identityTest`](fixtures/identities.ts)                                                                           | The API plus admin, app-access, API-only, and no-role identities.                |
| [`itemsTest`](fixtures/items.ts)                                                                                   | Identities and three collection schemas, with their data reset before each case. |
| [`createRedisTest`](fixtures/redis.ts), [`samlTest`](fixtures/saml.ts), [`createStorageTest`](fixtures/storage.ts) | The API and the selected auxiliary service.                                      |

Call `initializeFixtures()` after imports and any `vi.setConfig()` call. Each case must work when selected on its own.
Put prerequisites in fixtures or the test body. Files are isolated from each other, but cases within a file share state
unless their fixtures reset it. Use `setupRequest` or `setupGraphQL` from [fixtures/request.ts](fixtures/request.ts) for
setup requests so rejected or incomplete responses fail at the request boundary.

Use the default timeouts. See [timeout guidance](HARNESS.md#timeouts-and-environment) before adding an override.

For database connection tests, use [the TLS fixture](HARNESS.md#database-tls) to provision a verified TLS connection.

Name sustained-load suites `*.load.test.ts` so they run exclusively. See the [harness reference](HARNESS.md) for custom
fixtures, vendor exclusions, and process controls.

## Read results

Failures appear in the terminal during the run. Reports, process logs, and timings are retained in
`tests/integration/.artifacts/run-*`. The command prints the exact directory. Use `--output DIR` to choose a different
parent directory.

The harness cleans up owned processes, containers, and temporary data. Reports remain until you remove them. See
[cleanup and interrupted runs](HARNESS.md#cleanup-and-interrupted-runs) for recovery after a forced stop, and
[harness validation](HARNESS.md#validate-harness-changes) when changing the harness itself.
