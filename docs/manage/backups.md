---
title: Backups
description: What state a CairnCMS deployment needs you to back up, how to capture each piece, and how to test that a restore actually works.
sidebar:
  order: 4
---

CairnCMS does not ship a single "backup" command, because there is no single backup surface. A running deployment has state in several places, and a recoverable backup means capturing each one with the right consistency guarantees and exercising the restore path before you need it.

This page covers what state to back up, how to capture each piece, and the operational practices that turn backup files into a real recovery posture.

## What needs backing up

A CairnCMS deployment has four state surfaces:

1. **The database** — schema, content, users, roles, permissions, sessions, activity, comments, all of it. The system of record.
2. **File bytes** — the actual binary contents of uploads. Stored on local disk or in a remote storage backend (S3, GCS, Azure Blob, Cloudinary). The database has `directus_files` rows pointing to these bytes; the bytes themselves live elsewhere.
3. **Configuration and secrets** — environment variables (`.env` or your secret store), TLS certificates, and anything else outside the database that the deployment depends on to start.
4. **Custom code** — extensions, custom migrations, and email templates in `EXTENSIONS_PATH`. These belong in source control as part of your build pipeline, not in operational backups (see [What does not need a backup](#what-does-not-need-a-backup) below).

The first two are the ones a backup strategy has to capture explicitly.

## The database

Use the database vendor's native dump and restore tooling. CairnCMS has no special requirements here beyond the usual considerations: a consistent snapshot, encryption at rest, and a restore drill.

### PostgreSQL

`pg_dump` produces a logical dump that is portable across Postgres versions and includes schema and data:

```bash
pg_dump --format=custom --file=cairncms.dump \
  --host=<host> --username=<user> --dbname=<database>
```

Restore with `pg_restore`:

```bash
pg_restore --clean --if-exists --no-owner --dbname=<target> cairncms.dump
```

For high-availability deployments, prefer continuous archiving (WAL-E, WAL-G, or your managed provider's point-in-time recovery feature) over periodic logical dumps. PITR gives you per-second granularity instead of "the last time the dump ran." Most managed Postgres services (RDS, Cloud SQL, DigitalOcean, Crunchy) include PITR. Turn it on and configure the retention window.

### MySQL and MariaDB

`mysqldump` for logical dumps:

```bash
mysqldump --single-transaction --routines --triggers \
  --host=<host> --user=<user> --password \
  <database> > cairncms.sql
```

`--single-transaction` is important: it gets a consistent snapshot across InnoDB tables without holding a global lock that would freeze the application. Restore with `mysql < cairncms.sql`.

For larger databases or busy servers, consider Percona XtraBackup (MySQL) or Mariabackup (MariaDB) for hot binary backups, which restore faster than a `mysqldump` reload.

### SQLite

A SQLite database is one file. Two options:

- **Stop CairnCMS first**, copy the file, then restart. Simple but requires downtime.
- **Use the `sqlite3 .backup` command** while CairnCMS is running. This locks just enough to produce a consistent copy without stopping the application:

```bash
sqlite3 /cairncms/database/database.sqlite ".backup '/backups/cairncms-$(date +%F).sqlite'"
```

Do not just `cp` a SQLite file that CairnCMS is actively writing to — you will get a torn-page snapshot and an unrestorable backup.

SQLite is the right choice for small single-instance deployments. If your dataset and uptime requirements have grown beyond what SQLite handles comfortably, plan a one-time migration to Postgres before you optimize the SQLite backup process.

### Encryption and offsite storage

Wherever the dump lands, treat it as sensitive data:

- Encrypt at rest. Most object stores (S3, GCS, Azure) offer server-side encryption; turn it on and use a customer-managed key if your compliance requirements call for it.
- Replicate offsite. A backup that lives on the same machine as the database is one disk failure away from being useless.
- Apply a retention policy that survives the longest data-recovery scenario you actually plan for. Daily for a week, weekly for a month, and monthly for a year is a defensible baseline.

## File bytes

The `directus_files` table records metadata; the bytes live wherever your storage driver points. Backing up the database without backing up the bytes leaves you with broken file references.

### Local disk

If `STORAGE_LOCATIONS=local` and the storage root is a mounted volume, treat that volume the same as any other persistent volume. Snapshot it at the volume layer (LVM, ZFS, your cloud provider's block-storage snapshots) or rsync it to remote storage:

```bash
rsync -a --delete /cairncms/uploads/ /backups/uploads/
```

Local-disk storage is also the most fragile setup operationally. For any deployment that needs a multi-instance shape or independent durability guarantees, switch to a remote storage backend before you grow your backup tooling further.

### S3, GCS, Azure Blob

Remote storage backends already handle durability, for example, S3 stores 11 9's of durability across availability zones, and the equivalent services advertise similar numbers. The work that remains:

- **Versioning** — turn on bucket versioning so an accidental delete or overwrite can be undone within the retention window.
- **Cross-region replication** — protects against region-level outages and against an entire bucket being deleted (versioning does not protect you from bucket deletion).
- **MFA delete** — on S3, requires an MFA-authenticated request to permanently remove a versioned object. A safety net against an attacker with leaked credentials.
- **Object lock** — locks objects against deletion or modification for a fixed retention period. Useful when compliance requires immutable backups.

Combine these per your durability and threat model. A common starting point: versioning + 30-day retention on noncurrent versions + cross-region replication.

### Cloudinary

Cloudinary stores the master asset and exposes derived versions on demand. The "backup" surface is the original assets and their metadata. Cloudinary's own backup tools or a periodic export of original assets through the API covers the durability angle; combine with a tested restore plan that re-establishes the asset/`directus_files` row mapping.

## Configuration and secrets

A backup strategy that captures the database and file bytes but loses the deployment's secrets leaves you unable to actually start the recovered system. Cover at minimum:

- **`SECRET`** — the signing secret for access and refresh tokens. Losing it invalidates every existing access and refresh token; the recovered system will start, but every active session is forced back through login. Restoring the original `SECRET` keeps existing tokens valid across the recovery.
- **`KEY`** — the unique instance identifier. Required at startup and reported as the service ID in health checks. Treat it as part of the recovered deployment's identity rather than as a data-encryption key, but include it in the backup so the restored instance presents the same identity downstream consumers expect.
- **`DB_PASSWORD`** and any provider credentials (S3 keys, SMTP passwords, OAuth client secrets).
- **TLS certificates** if you manage them outside an automated provisioner like Let's Encrypt.

These belong in a secret store with its own backup story (Vault, AWS Secrets Manager, Doppler, 1Password, sealed-secrets in a Git repo). The point is that your secret store is part of the backup posture, not separate from it.

## Schema-as-code and config-as-code

Two CairnCMS CLI workflows produce versioned, human-readable artifacts of structural state:

- **`cairncms schema snapshot`** — captures collections, fields, and relations to a YAML or JSON file. Reapply with `cairncms schema apply`. See [Schema as code](/docs/manage/schema-as-code/).
- **`cairncms config snapshot`** — captures roles and permissions to a YAML directory. Reapply with `cairncms config apply`. See [Config as code](/docs/manage/config-as-code/).

These complement database backups; they do not replace them. Schema-as-code captures structure but no content, users, activity history, or sessions. Use them for environment promotion (dev → staging → production), change review in pull requests, and as a structural baseline that you can replay against an empty database. For disaster recovery, the database dump is still the source of truth.

## What does not need a backup

A few things show up in a backup discussion that should be elsewhere:

- **Extension code, custom migrations, email templates.** These live in `EXTENSIONS_PATH` and ship with your container image (or are pulled at build time from source control). Source control is the durability surface; backups would just duplicate it.
- **Generated thumbnails and image transforms.** CairnCMS regenerates these on demand from the original asset. Some operators back them up as a cache-warming optimization, but losing them only costs CPU on the first request after restore.
- **The application logs.** Send these to your log aggregator. Backing them up at the host level conflates application state with operational telemetry.
- **The CairnCMS image itself.** It is a published artifact. Pin a specific tag in your deployment manifest so an upstream registry change cannot leave you unable to redeploy.

## The restore drill

A backup that has never been restored is a hope, not a recovery plan. At minimum, on a recurring cadence:

1. Spin up an empty environment (a one-off container, a sandbox account, a staging instance).
2. Restore the most recent backup of each surface like database, file bytes, and secrets.
3. Start CairnCMS against the restored state.
4. Verify a content load, a file fetch, a user login, and a flow execution all work end-to-end.
5. Tear it down.

The first time you do this, expect to find at least one missing piece, such as a forgotten secret, a misconfigured storage path, or an undocumented manual fix. That is the entire point of the drill: surfacing those gaps when they are inconvenient, not catastrophic.

For deployments with stricter availability requirements, run the drill in CI on a defined schedule. A working backup is the one the system has just rehearsed restoring; everything else is a guess.

## Where to go next

- [Configuration](/docs/manage/configuration/) covers the environment variables that determine where state lives: `STORAGE_LOCATIONS`, `DB_*`, `EXTENSIONS_PATH`.
- [Migration between instances](/docs/manage/migration-between-instances/) covers moving state between deployments.
- [Schema as code](/docs/manage/schema-as-code/) and [Config as code](/docs/manage/config-as-code/) cover the versioned-artifact workflows for structural state.
