---
title: Schema as code
description: Capture a CairnCMS data model to a versioned file, review changes as a diff, and apply them across environments.
sidebar:
  order: 6
---

CairnCMS treats your data model as state that can be captured to a file, reviewed as a diff, and applied to another environment. The same file format works for environment promotion (dev to staging to production), peer review in pull requests, and a structural baseline you can replay against an empty database.

The two CLI commands `cairncms schema snapshot` and `cairncms schema apply` are the primary surface. An HTTP API equivalent exists for CI/CD pipelines that prefer not to shell into the container.

This page covers what's in a snapshot, the CLI workflow, the HTTP equivalent, and the cross-environment caveats that decide whether a snapshot is portable.

## What a snapshot captures

A schema snapshot contains:

- **Collections** — the user-defined collections in the database, with their metadata (name, icon, visibility, sort behavior, archive configuration, and so on).
- **Fields** — every field on every user-defined collection, with type, defaults, validation, conditional logic, interface and display configuration, options, special behaviors, and translations.
- **Relations** — the foreign-key and alias relations between collections, including junction tables for many-to-many and many-to-any setups.

It does not contain:

- **Content.** Items in your collections, file rows in `directus_files`, or any application data.
- **Files on disk** or in a remote storage backend.
- **Users, roles, and permissions.** These are handled by [config-as-code](/docs/manage/config-as-code/) which is a separate workflow with its own command.
- **System tables and system fields.** Anything CairnCMS owns is filtered out. The snapshot describes the project schema, not the platform.

Use schema-as-code for the structural side of the model. Use database backups (covered in [Backups](/docs/manage/backups/)) for content.

## The snapshot file

The file's top-level shape:

```yaml
version: 1
directus: 1.0.0
vendor: postgres
collections: [...]
fields: [...]
relations: [...]
```

`version` is the snapshot format version; CairnCMS currently emits `1`. `directus` is the platform version that produced the snapshot. `vendor` is the normalized database vendor name — one of `postgres`, `mysql`, `sqlite`, `cockroachdb`, `oracle`, `mssql`, or `redshift`. These three fields turn into a portability check at apply time. See [Cross-environment caveats](#cross-environment-caveats) below.

The bulk of the file is the three sorted arrays of collections, fields, and relations. Sorting is deterministic so snapshots produced from equivalent schemas diff cleanly in source control.

## Generating a snapshot

Write the current schema to a YAML file:

```bash
cairncms schema snapshot ./schema.yaml
```

The CLI is interactive by default. If the target file already exists, it asks before overwriting. To run unattended (CI, scripted deploys), pass `--yes`:

```bash
cairncms schema snapshot --yes ./schema.yaml
```

YAML is the default output format. To emit JSON instead:

```bash
cairncms schema snapshot --format json ./schema.json
```

Omit the path to write to stdout, which is convenient for piping into other tools or generating filename patterns:

```bash
cairncms schema snapshot --yes > "./snapshots/$(date +%F).yaml"
```

YAML is the right default for files committed to source control: human-readable, diffs cleanly, comments allowed in the format. JSON is useful when a downstream tool requires it.

## Applying a snapshot

Apply a snapshot file to the current database:

```bash
cairncms schema apply ./schema.yaml
```

The command:

1. Loads the snapshot file (YAML or JSON, detected from the extension).
2. Reads the current schema from the database and computes a structural diff against the snapshot.
3. If the diff is empty, exits with `No changes to apply.`
4. If the diff has changes, prints them grouped by collections, fields, and relations, with creates in green, updates in blue, and deletes in red.
5. Prompts for confirmation before applying. Apply only proceeds on `y`.

Two flags adjust the flow:

- **`--dry-run`** — print the planned changes and exit without applying. Useful for CI checks and pre-deploy review.
- **`--yes`** — skip the confirmation prompt and apply non-interactively.

The two are mutually exclusive in practice: `--dry-run` always exits without applying, and `--yes` only suppresses the prompt around an apply.

Applying a snapshot can drop columns when fields are removed and drop tables when collections are removed. The platform does not preserve content from a dropped column. Treat `--dry-run` as a required step before running `--yes` against a non-disposable database.

## Source control workflow

The intended pattern for a multi-environment project:

1. Develop the schema interactively in your dev instance (the app builder is the easiest editing surface).
2. Run `cairncms schema snapshot ./schema.yaml` to write the result to a file in your repo.
3. Commit the snapshot. The diff in the pull request shows the schema change. Reviewers see "added field `posts.published_at: timestamp`".
4. Once merged, your deploy pipeline runs `cairncms schema apply --yes ./schema.yaml` against staging, then production, after the platform upgrade step.

The snapshot is the source of truth that travels with the code. Direct schema edits to a non-dev environment will be detected as drift the next time `apply` runs against that environment. `apply` reconciles the database to the snapshot, not the other way around.

For larger teams, prefer running `cairncms schema apply --dry-run` in CI on every PR that touches the snapshot file. The diff that prints in the CI log is the same diff the deploy will apply, so reviewers get a preview without anyone needing to run the deploy locally.

## The HTTP API

For pipelines that cannot shell into a container, the same workflow is exposed as three HTTP endpoints. All require an admin token.

- **`GET /schema/snapshot`** — returns the current snapshot as JSON. Equivalent to `cairncms schema snapshot --format json` to stdout.
- **`POST /schema/diff`** — accepts a snapshot (JSON in the body, or YAML/JSON as multipart form upload), returns `{ hash, diff }`. The hash is a fingerprint of the current database snapshot at the moment the diff was computed.
- **`POST /schema/apply`** — accepts the `{ hash, diff }` payload from the diff endpoint and applies the diff. The hash is re-checked against the current state; if the database has changed since the diff was produced, the apply is rejected.

The two-step diff/apply flow is the safety net for HTTP. Between the moment you compute the diff and the moment you apply it, another admin or an automated process might have changed the schema. The hash check catches that and forces a re-diff.

The HTTP `/schema/diff` endpoint also validates that the snapshot's `directus` version and `vendor` fields match the running instance. The check can be bypassed by passing `?force` on the request, but the CLI does not enforce this validation at all.

## Cross-environment caveats

The fields stamped into the snapshot (`directus`, `vendor`) describe the environment the snapshot was produced from. Carrying a snapshot to an environment that differs along either axis is a known sharp edge:

- **Different platform version.** The HTTP `/schema/diff` endpoint refuses snapshots from a different platform version unless `force` is set. The CLI does not check; it will run the diff and apply against whatever version is running. Treat platform-version mismatches as a hint to upgrade or downgrade first, not a routine `--force` flag.
- **Different database vendor.** The same restriction. Some snapshots happen to apply cleanly across Postgres, MySQL, and SQLite; others do not, because column types, default expressions, and index behavior differ at the SQL level. Snapshot portability across vendors is not a guaranteed property of the format.
- **Drift between dev and prod.** A snapshot produced from a dev instance that has been edited interactively in prod will diff against the prod state. Decide before applying whether the prod-side edits should be preserved (re-snapshot from prod and merge) or overwritten (apply the dev snapshot as-is).

The conservative posture: keep environments aligned on platform version and database vendor, and let `apply` reconcile structural drift in one direction (file → database).

## What schema-as-code does not cover

Two adjacent surfaces look similar from a distance and need their own workflows:

- **Roles and permissions.** Captured by `cairncms config snapshot` and `cairncms config apply` — see [Config as code](/docs/manage/config-as-code/). The two commands are deliberately separate because the lifecycle of a permission change differs from the lifecycle of a schema change.
- **Content and seed data.** Schema-as-code never captures application data. For seeding a fresh environment with example content, use a database dump and restore (see [Backups](/docs/manage/backups/)) or write a custom migration that inserts the seed rows ([Custom migrations](/docs/develop/custom-migrations/)).

Schema-as-code is the structural baseline. Layer config-as-code on top for permissions, and a content-loading mechanism on top of that for data. Each surface has its own diffing semantics.

## Where to go next

- [Config as code](/docs/manage/config-as-code/) — the same diff/apply pattern for roles and permissions.
- [Migration between instances](/docs/manage/migration-between-instances/) — covers moving a complete deployment, of which a schema snapshot is one piece.
- [Custom migrations](/docs/develop/custom-migrations/) — the procedural alternative when a change is too imperative for a snapshot to capture cleanly (data backfills, complex transforms, conditional logic).
