---
title: Standalone schema commands
description: Compatibility reference for standalone schema snapshots and the diff/apply API.
sidebar:
  order: 10
---

:::caution[Standalone workflow is deprecated]
`cairncms schema snapshot`, `cairncms schema apply`, `POST /schema/diff`, `POST /schema/apply` and the SDK's `schemaDiff` and `schemaApply` commands are deprecated in 1.7.0. Use the unified [Config-as-code](/docs/manage/config-as-code/) workflow instead.

SDK callers should capture with `configSnapshot` and preview or apply that document with `configApply`. See [Config-as-code with the SDK](/docs/api/sdk/#config-as-code). `GET /schema/snapshot` and SDK `schemaSnapshot()` remain supported. See the [changelog](https://github.com/CairnCMS/cairncms/blob/main/CHANGELOG.md) for removal timing.
:::

<span id="source-control-workflow"></span>

This page documents the existing standalone workflow, which captures and applies schema in one file. For adoption without losing pending changes, see [Adopting the unified workflow](/docs/manage/config-as-code/migration/).

## What a snapshot captures

<span id="what-schema-as-code-does-not-cover"></span>

Snapshots contain collections, fields and relations with their metadata, using the same [schema coverage](/docs/manage/config-as-code/resources/schema/#what-is-covered) as config-as-code. They do not transfer content, roles, permissions or project settings. Use [Backups](/docs/manage/backups/) for data and [Custom migrations](/docs/develop/custom-migrations/) for data transformations.

## The snapshot file

Standalone snapshots have a format `version`, a producing release, a `vendor`, and arrays named `collections`, `fields` and `relations`.

| Format | Release field | Supported upload references |
| --- | --- | --- |
| Version 1 | `directus` | Source instance's folder IDs |
| Version 2 | `release` | Portable folder keys |

The `directus` field name is retained in version 1 for compatibility. Vendor values are `postgres`, `mysql` (also MariaDB) and `sqlite`. These version numbers are unrelated to config-as-code manifest versions.

## Generating a snapshot

```bash
cairncms schema snapshot ./schema.yaml
cairncms schema snapshot --format json ./schema.json
```

The command prompts before overwriting an existing file. `--yes` suppresses the prompt. YAML is the default regardless of the filename extension. Use `--format json` explicitly for a JSON file.

Use an explicit output path as shown above. Without one, the snapshot goes to stdout, where startup logs can mix with it.

### Choosing the version

An existing file keeps its version. New files and stdout currently default to version 1. To adopt version 2, preserve pending edits, change an existing file's `version` to `2`, then capture the source again into that file. Snapshot replaces its contents, including the release field and folder references. It does not convert unapplied changes offline.

An unreadable file or missing/unsupported version stops overwrite. Version 2 requires CairnCMS 1.7.0 or later. Older HTTP servers refuse it, while an older CLI can misinterpret folder keys as IDs.

:::caution[Snapshot default change]
Version 1 as the default is separately deprecated. New files, stdout and `GET /schema/snapshot` without a version will default to version 2 in 1.8.0 or later, no sooner than 30 days after 1.7.0 is published. Re-snapshotting an existing file preserves its version, and `?version=1` stays available. SDK 1.7.0 and later pins `schemaSnapshot()` to version 1. Older SDKs omit the version and will observe the new default. Upgrade the SDK or explicitly request version 1 to preserve that response format.
:::

## Applying a snapshot

```bash
cairncms schema apply ./schema.yaml --dry-run
cairncms schema apply ./schema.yaml
```

Review the dry run first. Interactive apply also prints the change list and asks for confirmation. `--yes` skips both that list and the prompt.

Back up before applying. Standalone apply can drop tables and columns without a `--destructive` flag. There is no force flag.

Successful dry runs exit `0`, including when changes are found. Caught apply failures exit `1`. Check the output as well as the exit code because a missing-system-tables error currently exits `0`.

An unchanged snapshot reports `No changes to apply.` If an apply fails, follow [Failure recovery](/docs/manage/config-as-code/recovery/) before retrying.

## Omitted properties

Capture the desired state from the source instance and retain every collection, field and relation you want to keep. Missing entries request deletion. For exceptional manual edits inside `meta` or `schema`, follow the [schema omission rules](/docs/manage/config-as-code/resources/schema/#omitted-properties).

## The HTTP API

All three endpoints require an administrator:

- `GET /schema/snapshot`: returns version 1 by default. `?version=2` selects portable references.
- `POST /schema/diff`: accepts a snapshot as JSON or a YAML/JSON multipart file. With changes, it returns HTTP `200` with `{ hash, diff }` under `data`. With no changes, it returns HTTP `204` with no body. Stop there rather than sending an empty payload to apply.
- `POST /schema/apply`: accepts the returned hash/diff payload, checks the current hash again, and applies it. It does not accept the original snapshot as that payload.

<span id="cross-environment-caveats"></span>

The diff endpoint checks that the source release and vendor match the server. The standalone CLI does not perform this check. Keep releases and vendors aligned when using either surface.

Any `force` query parameter skips the HTTP source check, including `?force=false`. Omit it entirely to keep the check enabled. Overriding it does not establish cross-version or cross-vendor compatibility.

If the target schema changes after you obtain the diff, apply returns `409 SCHEMA_STATE_CHANGED`. Generate and review a fresh diff before applying. Do not retry the stale payload.

## Upload folders

Version 2 resolves folder keys for the built-in upload interfaces, including nested repeaters and conditions. Every referenced folder must already exist on the target. Standalone apply does not prepare folders. Create them separately or use the unified workflow with managed folder declarations.

<span id="where-to-go-next"></span>

List keys with administrator `GET /folders?fields=id,name,key`. If a version 2 capture reports a missing folder reference, repair the named field and retry. Version 1 copies source IDs without that check. See [migration guidance](/docs/manage/config-as-code/migration/#from-a-standalone-schema-file) before using a version 1 snapshot on another instance.

Review extension interface options separately because embedded folder IDs are copied unchanged.
