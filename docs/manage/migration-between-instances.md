---
title: Migration between instances
description: Move a CairnCMS deployment from one place to another — full clones, structure-only promotions, content moves, and cross-vendor migrations.
---

"Migration" can mean several different things for a CairnCMS deployment, and the right procedure depends on which one you mean. Cloning a production instance to a development environment is a different operation from promoting a development schema to staging, and both are different from changing database vendors.

This page lays out the migration shapes, the right procedure for each, and the surfaces that have to move together to end up with a working instance on the other side.

## Pick the migration shape

Three common shapes:

1. **Full instance clone.** Move everything — schema, content, users, roles, files, secrets — to a new home. New host, managed-database provider, copy of production for offline analysis, that kind of thing. The procedure is a database dump plus a file-storage copy.
2. **Structure promotion.** Move the data model and the role/permission setup from one environment to another, without content. Dev to staging, staging to production, branch to mainline. Schema-as-code and config-as-code handle this together.
3. **Content move.** Move some or all collection rows between environments where the schema already matches. Can use a database-level dump of specific tables or the HTTP API for selective transfer.

The list of caveats, including cross-vendor compatibility, cross-version compatibility, and file-row consistency, apply to all three but matters most for the first.

## Full instance clone

The complete state of a deployment lives in three places: the database, the file-storage backend, and the configuration. To clone a deployment you have to copy all three.

### 1. Take a coordinated snapshot

Pause writes, or accept some inconsistency, and capture:

- A database dump (`pg_dump`, `mysqldump`, `sqlite3 .backup`). See [Backups](/docs/manage/backups/) for the per-vendor commands.
- A copy of the storage backend's contents — the actual bytes for any files in `directus_files`. For local-disk storage, an `rsync` of the upload root. For S3 / GCS / Azure Blob, a bucket-to-bucket copy with the cloud provider's tooling. For Cloudinary, an asset export.

These two captures should describe the same point in time. If your deployment has heavy concurrent writes, take both during a brief maintenance window. For lightly-loaded deployments, capturing them in sequence is usually fine. Files added between the two captures show up as missing-byte errors that you can resolve manually.

### 2. Restore on the target

On the destination:

- Restore the database dump into a fresh database. Whether the target database has to be precreated depends on the vendor and tool: `pg_restore --dbname=<name>` expects the database to exist (use `pg_restore --create` against the postgres database to create it as part of the restore); `mysql < dump.sql` similarly expects the schema to exist unless the dump contains `CREATE DATABASE`; SQLite creates the file on the fly. Check the `vendor`-specific commands in [Backups](/docs/manage/backups/) before running.
- Restore the file bytes into the new storage backend. The destination's `STORAGE_LOCATIONS` and per-driver paths must match what the original deployment used, because `directus_files` rows reference files by `storage` (the location name) and `filename_disk` (the path within that location). If you change storage backends, see [Changing storage backends](#changing-storage-backends) below.

### 3. Bring up CairnCMS pointed at the restored state

Configure the destination's `.env` (or secret store) to point at the restored database and storage backend. The minimum configuration that has to match the original:

- **`SECRET`** — the signing secret for tokens and sessions. Keep it identical to the source if you want active sessions and outstanding refresh tokens to remain valid across the migration. Changing it invalidates every existing access and refresh token.
- **`KEY`** — the unique instance identifier. Required at startup and reported as the service ID in health checks. Carry the source's `KEY` over so the migrated instance presents the same identity that downstream consumers and operators expect.
- **`STORAGE_LOCATIONS`** and per-driver settings — must match the locations referenced by `directus_files.storage`.
- **`PUBLIC_URL`** — sets the externally-reachable URL for asset links and email templates. Update this for the new home.

Bring up the new instance, run `cairncms bootstrap` once to verify migrations are at the expected version, and the clone is online.

### 4. Switch traffic

DNS or load-balancer change to point at the new instance, with the old one kept running until you are sure the new one is healthy. The old instance's database becomes a fallback you can repoint at if the new one needs an emergency rollback.

## Structure promotion

When you only want to move the data model and the role/permission setup use the snapshot/apply pattern. This is the right shape for dev → staging → production promotion.

The procedure pairs two existing CairnCMS workflows:

```bash
# On the source (dev)
cairncms schema snapshot ./schema.yaml
cairncms config snapshot ./config

# Commit both to source control, open a PR, review the diffs

# On the target (staging or production), after merge
cairncms schema apply ./schema.yaml
cairncms config apply ./config
```

The two commands run in that order: schema first (so collections, fields, and relations exist), then config (so permissions can reference the now-present collections). See [Schema as code](/docs/manage/schema-as-code/) and [Config as code](/docs/manage/config-as-code/) for the full reference on each.

For environments that need automated promotion, run the same two commands as steps in the deploy pipeline. Prefer `--dry-run` against the production database in CI on every PR, so the eventual deploy diff is visible before merge.

## Content move

Snapshots never contain content; database dumps always do. For moving content between two instances that already share a schema, the choices:

### Selective table dump

Dump and restore just the user-defined tables, leaving each side's own users, roles, sessions, and activity log untouched:

```bash
# Postgres example: dump only specific tables
pg_dump --data-only --table=articles --table=authors \
  --host=<source-host> --username=<user> --dbname=<source-db> > content.sql

psql --host=<target-host> --username=<user> --dbname=<target-db> < content.sql
```

The same shape works for `mysqldump --tables` or `sqlite3 .dump`. Use `--data-only` (or vendor equivalent) to skip schema, since the target already has the schema in place.

This is the cheapest content move, but it does not handle file relations cleanly: a row in `articles` that references `directus_files.id = '...'` will point at a file that does not exist on the target unless you also move the matching `directus_files` row and the underlying bytes.

### HTTP API replay

For finer control such as selective filtering, transformation, and partial moves, the HTTP API works well. Read items from the source with the SDK or `fetch`, then create them on the target. The SDK is the easiest tool for this; see [Clients](/docs/develop/clients/) for the usage pattern.

The tradeoff is performance and consistency. The API enforces validation and permissions on every write, which is correct but slower than a bulk SQL load. For migrations of millions of rows, the table-dump approach is usually faster.

## Cross-vendor migration

Moving from one database vendor to another (Postgres ↔ MySQL ↔ SQLite) is the hardest variant. Three layers of incompatibility:

- **Column types and defaults** are not strictly portable. A Postgres `timestamp with time zone` is not a MySQL `DATETIME`; SQLite's loose typing will accept either but loses precision.
- **The schema-as-code snapshot stamps the source vendor.** The HTTP `/schema/diff` endpoint refuses cross-vendor application unless `?force=true` is set; the CLI does not enforce this but the resulting database may have subtly wrong types.
- **A native database dump is vendor-specific.** A Postgres dump cannot be loaded into MySQL.

The only reliable approach is to recreate the schema natively on the target and replay content through the HTTP API:

1. Stand up the target instance with the right vendor.
2. Apply the schema snapshot from the source against the target. The CLI `cairncms schema apply` does not gate on the snapshot's stamped vendor, so it will run against a different-vendor target as-is. Spot-check critical fields for type drift; correct any that did not translate. (If you go through the HTTP `/schema/diff` endpoint instead, it will refuse the cross-vendor snapshot unless you pass `?force=true` — that bypass is HTTP-only.)
3. Apply config-as-code against the target.
4. Replay content through the HTTP API or a vendor-specific data tool that handles the type mapping.
5. Move file bytes.

Treat cross-vendor migration as a project rather than a procedure. Plan a non-prod rehearsal on representative data first.

## Cross-version migration

A migration between deployments running different CairnCMS versions is two operations stacked: a version upgrade and a host move. Decide the order:

- **Upgrade first, then move.** Upgrade the source to match the target, take a fresh dump and snapshot, then move. Lower risk, since the upgrade happens on the host that already works.
- **Move first, then upgrade.** Clone to the new host on the source's old version, then upgrade in place. Useful when the old host is on a deprecated platform and you are also using the move to escape it.

The HTTP `/schema/diff` endpoint refuses snapshots from a different platform version unless `?force=true`. The CLI does not enforce this. Treat a version mismatch as a hint to align versions first, not a routine `--force` flag.

For major-version moves, also see the extension-rebuild step in [Upgrades](/docs/manage/upgrades/).

## File bytes

Every move that includes content has to move the file bytes too. The cheapest mistake to make is moving the database without the storage backend — the new instance comes up, lists items, and serves 404s for every file because the bytes are not where `directus_files.filename_disk` says they are.

Two specific consistency rules to keep in mind:

- The `directus_files.storage` value must name a configured storage location on the target. Keeping the same `STORAGE_LOCATIONS` value across the move is the simplest path.
- The `filename_disk` path is relative to the storage location's root. Renaming files during the move breaks every reference. Move bytes verbatim.

### Changing storage backends

When the move also changes storage backends, say, from local disk to S3, there is a third step. After the database is restored:

1. Reupload the file bytes into the new backend.
2. Update `directus_files.storage` and, if the path scheme is different, `filename_disk` to match.

This is database-side work, not a snapshot operation. A custom migration ([Custom migrations](/docs/develop/custom-migrations/)) is a clean place to put a one-time backfill, since the migration runs as part of the next bootstrap and is recorded in `directus_migrations`.

## Sequencing

For any non-trivial migration, the order of operations matters. The conservative sequence:

1. Bring up the target's database and storage backends, empty.
2. Restore the database dump (full clone) or apply the schema snapshot (structure promotion).
3. Restore file bytes if applicable.
4. Apply config-as-code if applicable.
5. Configure secrets to match the source where required (`KEY`, `SECRET`, `STORAGE_*`).
6. Bring up the CairnCMS process. Verify the API responds, the admin app loads, and a sample item-fetch succeeds.
7. Validate end-to-end: log in as a known user, fetch a known asset, run a flow, check the activity log.
8. Switch traffic.

Stop at step 7 if anything fails to validate. The previous instance is still serving so there is no urgency to flip the switch on a half-working migration.

## Where to go next

- [Schema as code](/docs/manage/schema-as-code/) — the snapshot/apply mechanism for the data model.
- [Config as code](/docs/manage/config-as-code/) — the snapshot/apply mechanism for roles and permissions.
- [Backups](/docs/manage/backups/) — per-vendor dump and restore commands, the same machinery used for full-instance migration.
- [Upgrades](/docs/manage/upgrades/) — the version-bump procedure that pairs with cross-version migrations.
