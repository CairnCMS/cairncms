---
title: Custom migrations
description: Add custom database migrations to a CairnCMS instance through the migrations folder convention.
sidebar:
  order: 3
---

CairnCMS uses [Knex](https://knexjs.org/) migrations to manage its schema. Custom migrations let you add your own for schema changes that should travel with the deployment, run once per environment, and be tracked the same way the built-in migrations are.

This is not an extension type. There is no SDK, `defineMigration`, or `cairncms:extension` manifest involvement. Custom migrations are picked up by file convention from the configured extensions folder.

## When to use a custom migration

Reach for a custom migration when:

- You need a schema change that should run once per environment (a new index, a new table outside CairnCMS's collection model, a vendor-specific column type).
- You need to backfill or rewrite data in a way that ships alongside code.
- You want CairnCMS to track whether the change has run, so it does not run again on the next deploy.

Stay with normal CairnCMS schema tools (Settings > Data Model, schema-as-code apply) when:

- The change is just a collection or field addition. Those are tracked in CairnCMS's schema model and can be exported as schema snapshots.
- The change should be applied per environment by an operator, not automatically on deploy.

Custom migrations are for changes outside the schema model such as direct table-level schema work, low-level data fixes, or anything Knex can do that the schema apply pipeline cannot.

## File location and naming

Place migration files under the configured extensions folder:

```
<EXTENSIONS_PATH>/migrations/
├── 20260101A-add-orders-index.js
└── 20260205A-backfill-tenant-ids.js
```

Custom migration files must:

- be plain JavaScript (`.js`); the loader does not pick up `.ts` files for custom migrations
- start with a unique version prefix, separated from the description by a dash

CairnCMS's built-in migrations use the format `<YYYYMMDD><LETTER>-<description>.ts`, where the letter disambiguates multiple migrations on the same date (`A`, `B`, `C`, …). Following the same convention for custom migrations is recommended, because it puts custom and built-in migrations in a sensible chronological order and avoids version collisions.

The version (the part before the first `-`) must be unique across all migrations, built-in and custom combined. CairnCMS refuses to start if it detects two migrations with the same version key.

## Migration file structure

Each migration exports an `up` function and a `down` function. Both receive a Knex instance:

```js
export async function up(knex) {
  await knex.schema.createTable('audit_log', (table) => {
    table.increments('id');
    table.string('actor_id').notNullable();
    table.string('action').notNullable();
    table.timestamp('created_at').defaultTo(knex.fn.now());
    table.index('actor_id');
  });
}

export async function down(knex) {
  await knex.schema.dropTable('audit_log');
}
```

`up` runs when the migration is applied. `down` runs when it is rolled back. The two should be exact inverses. Anything `up` creates, `down` should drop; anything `up` modifies, `down` should restore.

Use Knex's schema builder rather than raw SQL where possible. Knex translates schema operations to the dialect of whichever vendor CairnCMS is connected to, which keeps the migration portable across SQLite, PostgreSQL, MySQL, and MariaDB.

## Versioning and ordering

CairnCMS sorts all migrations (built-in plus custom) by their version prefix and runs them in that order. The version is the part of the filename before the first `-`.

A migration named `20260101A-add-orders-index.js` has version `20260101A`. CairnCMS records that version in the `directus_migrations` table when the migration completes. On the next startup or migrate run, it sees the version is already recorded and skips it.

The recorded version is the only thing that prevents re-running. Renaming a migration after it has run leaves the old version recorded but the new one unapplied, effectively double-running. Treat migration filenames as immutable once they have shipped to any environment.

## Running migrations

CairnCMS provides three migration commands through the CLI:

```bash
cairncms database migrate:latest
cairncms database migrate:up
cairncms database migrate:down
```

- **`migrate:latest`** — applies every migration that has not yet been applied. Most common command; run on deploy.
- **`migrate:up`** — applies only the next pending migration.
- **`migrate:down`** — rolls back the most recently applied migration.

CairnCMS also runs `migrate:latest` automatically as part of `cairncms bootstrap`, both on first-time install (after creating the system tables) and on subsequent bootstrap invocations against an already-initialized database. Bootstrap is the path most deploy pipelines use, so in practice migrations get applied as part of routine deploys without an explicit `migrate:latest` step.

Normal server startup (running the API process) does not apply migrations. It only validates that all known migrations have been recorded in `directus_migrations` and warns in the log if any are missing.

## Tracking

CairnCMS keeps a record of every applied migration in the `directus_migrations` table:

| Column | Description |
|---|---|
| `version` | the version prefix from the filename |
| `name` | a human-readable name derived from the rest of the filename |
| `timestamp` | when the migration was applied |

The bootstrap process also uses this table to decide whether the database is fully migrated. Custom migrations participate in that check the same way built-in ones do.

## A complete minimal example

A migration that adds a `tenant_id` column to an existing `orders` collection and indexes it.

`<EXTENSIONS_PATH>/migrations/20260301A-add-orders-tenant-id.js`:

```js
export async function up(knex) {
  await knex.schema.alterTable('orders', (table) => {
    table.string('tenant_id', 36);
    table.index('tenant_id');
  });
}

export async function down(knex) {
  await knex.schema.alterTable('orders', (table) => {
    table.dropIndex('tenant_id');
    table.dropColumn('tenant_id');
  });
}
```

After dropping the file in place, run `cairncms database migrate:latest` (locally or as part of a deploy step). CairnCMS picks up the new file, applies it, and records `20260301A` in `directus_migrations`. Subsequent runs skip it.

## Cautions

- **Custom migrations run with full database privileges.** They are not scoped by any role or permission system. Anything the connected DB user can do, a custom migration can do. Review them like infrastructure code.
- **Schema changes outside CairnCMS's model can drift from the schema snapshots.** If you migrate a column directly that is part of a CairnCMS collection, the next snapshot/apply cycle may not know about it. Prefer schema-as-code for changes inside the collection model.
- **Down migrations are best-effort.** Rolling back is helpful during development; in production, rolling forward (with a new migration that fixes the previous one) is usually safer than rolling backward.

## Where to go next

- [Configuration](/docs/manage/configuration/) covers `EXTENSIONS_PATH` and other operator-side settings.
- [Schema as code](/docs/manage/schema-as-code/) covers the snapshot/apply workflow for changes inside CairnCMS's collection model.
- [Email templates](/docs/develop/email-templates/) is the other convention-based developer customization path documented here.
