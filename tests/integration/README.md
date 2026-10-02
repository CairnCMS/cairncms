# API integration tests

These tests exercise the compiled API with a fresh database and API process for each test file. You can run a single
case, a suite, or all suites across six database vendors.

## Run tests

Use Node.js 22 and the repository's pinned pnpm version. PostgreSQL is the default and requires a running Docker daemon
and the Docker CLI. The harness starts and stops its own containers.

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

Available vendors are `postgres`, `postgres10`, `mysql`, `mysql5`, `maria`, and `sqlite3`. You can also select one with
`TEST_DB`. SQLite suites that use Redis, SAML, or S3 still need Docker.

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

Name sustained-load suites `*.load.test.ts` so they run exclusively. See the [harness reference](HARNESS.md) for custom
fixtures, vendor exclusions, and process controls.

## Read results

Failures appear in the terminal during the run. Reports, process logs, and timings are retained in
`tests/integration/.artifacts/run-*`. The command prints the exact directory. Use `--output DIR` to choose a different
parent directory.

The harness cleans up owned processes, containers, and temporary data. Reports remain until you remove them. See
[cleanup and interrupted runs](HARNESS.md#cleanup-and-interrupted-runs) for recovery after a forced stop, and
[harness validation](HARNESS.md#validate-harness-changes) when changing the harness itself.
