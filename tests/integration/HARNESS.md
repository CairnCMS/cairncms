# Integration harness reference

Use this reference when extending fixtures, diagnosing interrupted runs, or changing the harness. Start with the
[README](README.md) for everyday test commands and a first-suite example.

## Selection and failure reporting

File arguments are Vitest path filters relative to `tests/integration`. Multiple filters select their union. `-t`
matches a regular expression against full test names. Unmatched files, invalid expressions, and empty selections fail
before services start.

A local selection containing only declared vendor exclusions reports `NOT APPLICABLE`, with reasons and zero runnable
cases. It exits successfully without claiming any case passed. CI requires an explicit vendor and at least one runnable
case. It rejects file/name filters and listing-only execution.

Local runs stop on failure unless `--collect-all` is set. CI always collects all failures. Retries are disabled.
`.only`, undeclared skips, per-case retries, repeats, concurrent test bodies, and inverted failures are rejected.

Local runs default to one worker. `--workers` accepts 1 through 4. Ordinary files can run in parallel with separate
databases and API processes. Files named `*.load.test.ts` run first, one at a time, before any ordinary file starts.
Separate invocations can still compete for machine resources.

Failures appear in piped output during execution. Vitest reports completed cases after their hooks finish, so a running
hook remains subject to its deadline. Actions also receives native Vitest error annotations.

The final summary distinguishes failures, blocked dependents, unexpected skips, and selected cases that never ran. A
failed shared prerequisite is reported by its first dependent case. Remaining dependents are blocked without repeating
setup. Missing, malformed, or incomplete reports fail the command even if the runner exits successfully. Pending cases
after cancellation or an early stop are not counted as passes.

## Extend fixtures

### Setup and case independence

Every suite calls `initializeFixtures()` after imports and any `vi.setConfig()` call. This registers a native hook so
automatic fixture setup uses the hook deadline. Missing initialization or a later hook-timeout change fails collection.
Resolve expensive prerequisites through an automatic fixture or native hook. Lazy fixtures requested by a test body use
the body deadline.

Cases must establish their prerequisites without depending on another case. Module imports declare tests before
provisioning, so do not create resources at import time. File isolation does not reset state between cases. Use fixtures
or hooks to reset shared data where needed, and do not run bodies concurrently against mutable file fixtures.

Use `setupRequest` and `setupGraphQL` from [fixtures/request.ts](fixtures/request.ts) for setup requests. They check
successful responses and returned data, with API error details on failure. Use the ordinary request helper for
intentional rejection tests, or specify the expected rejection with `.expect(status)`.

### API configuration and services

Use [createApiTest](fixtures/environment.ts) to configure a file's API:

- `createApiTest(true)` enables the create-action hook.
- `createApiTest({ hookFixtures: ['roles-continuity-barrier'] })` selects a named hook fixture.
- `createApiTest({ extensions: [...] })` selects packaged extension fixtures. Required extensions must load before cases
  run. Diagnostic cases can declare another expected extension status.
- `createApiTest({ bootstrap: 'fresh' })` exercises bootstrap directly.
- `migrations: ['filename.cjs']` selects custom migrations from [fixtures/migrations](fixtures/migrations).

Redis, SAML, and storage fixtures provision their services only for importing suites. They require Docker even with
SQLite. Login and health tests need none of these services or extension fixtures.

When composing service fixtures, define their configuration before extending with `apiFixtures`. Vitest 3 binds
dependencies when `extend()` runs. Use one environment configuration per file because file fixtures share named slots.
Pass the native `teardownFailures` fixture to `capturePrerequisite()` when composing a resource-owning fixture. This
preserves setup failures and lets all owned resources finish cleanup before teardown errors are reported.

### Vendor exclusions

Use `describeForVendors(name, supportedVendors, reason, body)` beside the affected cases. State the vendor constraint or
coverage limitation in the reason. A bare `.skip` or dynamic skip fails result accounting.

### Companion processes and commands

The [Api type](fixtures/environment.ts) exposes owned process helpers:

| Helper                                              | Use                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `api.start(overrides)`                              | Start a companion API sharing the file's database, storage, and extensions.                         |
| `api.stop(child)`                                   | Stop an owned process and wait for exit.                                                            |
| `api.cli(args, options)`                            | Run the compiled CLI and capture its output and exit status. The default deadline is 25 seconds.    |
| `api.startNode(resolvedEntry, args, { timeoutMs })` | Run an owned Node tool, such as autocannon. Await its `result` and assert the expected exit status. |

Put generated CLI/config files inside `api.directory` so teardown removes them. Use
`api.start(overrides, { absoluteOrigin: true })` when a companion needs its own origin before initialization. A
synchronous `onSpawn` callback can capture startup logs before readiness. Owned tools participate in cancellation and
orphan cleanup.

### Timeouts and environment

Request helpers use a 10-second response deadline and a 30-second total deadline. Batch cases use 120-second limits.
Test bodies default to 30 seconds, hooks to 120 seconds, and bootstrap/API readiness to 90 seconds.

Test workers, bootstrap, and base API processes use UTC. Explicit timezone scenarios override only their owned process.
Use real REST/GraphQL requests when testing transport behavior.

## Database initialization and runtime

Testcontainers starts one database engine per vendor invocation using pinned image digests and ephemeral ports. Every
file receives its own database, API process, and storage/extensions directories. SQLite uses a unique file with foreign
keys enabled. Server vendors require the Docker CLI to address the same daemon as Testcontainers.

Eligible files restore a pristine initialized database to reduce startup time. PostgreSQL clones a connection-disabled
template, MySQL and MariaDB use their engine's dump/import tools, and SQLite copies a closed database file. The template
belongs to one invocation and is bound to its build, engine, and initialization configuration. Restoration verifies
schema, seed data, and generated-identity state before API startup.

Supported memory-cache, file-limit, and local/S3 settings reuse initialization automatically. Unknown settings, absolute
origins, extensions, and custom migrations use ordinary bootstrap. Test authors use the same fixtures in both cases.
Restoration does not share mutable databases or reset data between cases. `pristine.json` records ownership and
`provisioning.jsonl` records restoration, fallback, and tool outcomes.

The API entrypoint calls production `startServer()`. Its defaults are `SERVE_APP=false` and relative `PUBLIC_URL='/'`.
Absolute-origin fixtures reserve a TCP listener before initialization and forward traffic to the API. Use direct
listeners when testing client-IP and trust behavior.

Bootstrap and CLI commands run the compiled CLI. The harness requires the compiled confined bundle and WASM, rejects
development-child resolution, and records runtime configuration, extension hashes, and diagnostic posture. API and
bootstrap processes use `--no-node-snapshot`, with schema caching enabled. Tests exercise this configured runtime rather
than the full published container image.

## Cleanup and interrupted runs

Ctrl+C and SIGTERM cancel the runner and stop owned children. Teardown waits for process exit before deleting databases
and temporary files, escalating to SIGKILL after five seconds. MySQL-family database deletion has a 60-second deadline.
Ordinary administrative queries and PostgreSQL deletion have 10-second deadlines. Testcontainers' resource reaper
handles abandoned containers. Do not disable it.

A forced kill can leave temporary files or other resources. Before deleting leftovers, verify that their owner is no
longer running and consult the records in that run's artifact directory:

| Record                                   | Identifies                                                        |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `*.owner.json`                           | Owned temporary directories and process IDs.                      |
| `container.json`                         | The database container.                                           |
| `*.service.json`                         | Auxiliary service containers.                                     |
| `*.startup.json`, `*.startup.docker-log` | Container startup state, port diagnostics, and Docker log output. |

If startup stopped before the container ID was recorded, its `cairncms.integration.run` label matches the run directory
name. Remove only the resources identified by that run. Never prune unrelated Docker resources.

Ordinary teardown removes temporary data but retains reports and logs. To reclaim space after a completed run, remove
its exact `.artifacts/run-*` directory. After an interrupted run, reconcile its owned resources first. Keep evidence
needed for review before deleting reports.

## Validate harness changes

Run these commands from the repository root:

```bash
pnpm --filter tests-integration typecheck
pnpm --filter tests-integration test:harness

# Requires preparation and Docker. Checks crashes, cancellation, and owned processes.
TEST_DB=sqlite3 pnpm --filter tests-integration test:lifecycle
TEST_DB=postgres pnpm --filter tests-integration test:lifecycle

# Requires Docker. Checks Redis, SAML, and S3 cleanup under failure and cancellation.
pnpm --filter tests-integration test:services

# Requires preparation and Docker. Set TEST_DB to the engine under test.
TEST_DB=postgres pnpm --filter tests-integration test:restoration
```

Deliberately failing controls under `harness/controls` are excluded from ordinary discovery. Reporting checks verify
that earlier errors remain visible through a pipe while a later case runs. Lifecycle checks verify failure status,
exited children, and removal of owned temporary data. PostgreSQL lifecycle checks also cover shared-engine loss.

Restoration controls exercise real capture/import, concurrent isolation, corruption rejection, configuration and custom
migration fallback, bootstrap equivalence, crashes, and cancellation. Run them for each supported engine when changing
bootstrap behavior, supported runtime settings, or engine image pins. Set `INTEGRATION_CONTROL_OUTPUT` to retain control
reports. Raw templates are always removed during cleanup.
