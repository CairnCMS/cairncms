---
title: Schema
description: Per-collection model files, omission rules, portable upload folders, and source compatibility checks.
sidebar:
  order: 1
---

The `schema` kind manages collections, fields, relations and their metadata. It requires manifest version 3 and writes one `.yaml` file per collection in `schema/`. Make model changes on the source instance and capture them with `cairncms config snapshot`.

## What is covered

Snapshots include configured collections, unconfigured database tables and custom fields you add to system collections. They exclude CairnCMS's built-in system definitions, internal storage tables and tables listed in `DB_EXCLUDE_TABLES`, along with relations involving internal or excluded tables.

`DB_EXCLUDE_TABLES` makes CairnCMS ignore a table entirely. Use it only for tables that should also be excluded from the application.

Snapshots do not include table contents. Back up data before applying changes. Check any `UNCONFIGURED_TABLE_DROP` warning carefully because the table may belong to another application.

## Per-collection documents

Each file declares `collection`, `fields` and `relations`. `fields` and `relations` are arrays, including when empty. Relations are stored with the collection that owns their foreign-key field. Their `related_collection` identifies the other side and can be null.

Ordinary collection documents also declare `meta`, which may be null, and carry their captured `schema` when applicable. For system collections, manage only your custom fields and relations. Do not add a collection `meta` or `schema` definition.

Keep generated filenames. A simple collection name such as `articles` uses `articles.yaml`. Names that need normalization or conflict with reserved filenames use a suffix such as `<slug>-<8 hex>.yaml`. The `collection` property, not the filename, identifies the collection.

Renaming a file alone does not rename a collection. Changing a collection or field name in the document can plan a deletion and creation without transferring data. Unrecognized filenames and `.yml` files are skipped, which can also lead to deletions. See [Files the reader skips](/docs/manage/config-as-code/resources/#files-the-reader-skips).

## Omitted properties

Start with a generated capture and keep every collection, field and relation that should remain. Leaving one out requests deletion.

Within an existing `meta` or `schema` object, omitted direct properties retain the target's current values. An explicit null clears a nullable property, such as `note: null`.

Keep the enclosing objects as captured. Removing a field's entire `schema` is not a way to preserve its column.

Nested values are replaced, not recursively merged. When supplying `meta.options`, include every option you want to retain. If you change how an interface uses upload folders, also provide its affected `options` or `conditions`.

## Source release and vendor

The manifest records the capture's release and vendor:

```yaml
schema:
  release: 1.7.0
  vendor: postgres
```

These are illustrative values. Snapshot writes the actual source stamp. PostgreSQL reports `postgres`, MySQL and MariaDB report `mysql`, and SQLite reports `sqlite`.

Apply and dry run require an exact release and vendor match. Missing or mismatched information returns `CONFIG_SCHEMA_SOURCE`. After assessing compatibility, use `--force-schema` or HTTP `force_schema=true` to waive this check. Other validation and deletion safeguards still apply.

Even a patch-version difference requires that override. Cross-vendor deployment needs particular care because types, defaults and indexes can differ. Keep the recorded source values rather than editing them to hide a mismatch.

## Upload folders

Use folder keys for `file`, `file-image`, `files`, `input-rich-text-html` and `input-rich-text-md`, including those interfaces nested in repeater (`list`) fields and field conditions.

The folder must already exist or be declared in managed [folders](/docs/manage/config-as-code/resources/folders/). If snapshot, preview or apply reports a missing folder reference on the target, repair the named field before retrying.

Extension-defined interface options are copied as supplied. Their embedded folder IDs are not automatically made portable. Review those options separately.

## Apply and recovery

Avoid concurrent schema edits during deployment. If apply fails or reports `SCHEMA_STATE_CHANGED`, inspect the target and review a fresh preview before retrying. See [Failure recovery](/docs/manage/config-as-code/recovery/).
