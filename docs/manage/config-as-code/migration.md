---
title: Adopting the unified workflow
description: Add schema to an existing config-as-code directory or move from standalone snapshots without losing pending changes.
sidebar:
  order: 9
---

Existing version 1 and 2 config-as-code directories remain supported. Upgrade the manifest and capture schema when you are ready to manage the data model in the same tree.

## From an existing config-as-code directory

Snapshot recaptures every selected kind, not just schema. Use a separate directory so it does not overwrite your pending edits.

1. Preserve the current tree and any unapplied edits in source control or a separate copy.
2. Choose a source instance running CairnCMS 1.7.0 or later, with the same release and database vendor as the intended target.
3. Create a separate `config-upgrade` directory. Copy only the existing `cairncms-config.yaml` manifest into it. Leave the original tree untouched.
4. In the copied manifest, change `version` to `3` and add `schema` to the intended resource list. Do not automatically enable every kind.
5. Capture the source into `config-upgrade`, then review all files and the recorded schema release/vendor.

```bash
cairncms config snapshot ./config-upgrade --yes
```

Port intended unapplied edits from the saved tree into this new capture and review them. Snapshot does not merge those edits automatically. Replace the deployment tree only after the combined result has been reviewed and tested.

Preview against the target with `cairncms config apply --dry-run`. Check that the tree retains every collection and field you intend to keep.

## From a standalone schema file

There is no conversion command. The unified manifest and per-collection documents are not the same format as standalone snapshot versions 1/2. Renaming `schema.yaml` or changing its version header does not convert it.

First check whether a live source matches the desired standalone snapshot. Run against that source's initialized database:

```bash
cairncms schema apply ./schema.yaml --dry-run
```

Require the explicit `No changes to apply.` message. Exit `0` alone is not proof, because standalone dry runs with changes also exit `0`. Resolve any differences or errors before treating the source as a match.

If the source matches, capture it using `cairncms config snapshot` into a separate directory. Use the same release and vendor as the intended target. For a schema-only tree, pre-create this manifest:

```yaml
version: 3
resources:
  - schema
```

Snapshot fills the release/vendor stamp and collection files. Schema-only apply will not create missing upload folders. Either provision them separately or deliberately add `folders` and capture its complete desired set.

If the standalone file contains pending changes, a fresh live capture will not include them. Preserve the file. Where practical, realize and verify it on an isolated instance with the intended target's release and vendor, then capture that state as a config-as-code tree.

Version 1 standalone files carry source folder IDs. Applying one to an empty instance does not recreate those folders or translate the IDs. The isolated instance needs the corresponding source folder records, for example from an isolated backup restore, or you must repair the upload references before taking a unified capture. A dangling supported reference blocks that capture. Version 2 files instead require existing folders with the referenced keys.

Otherwise port the intended changes into a generated tree and review the whole result. Do not apply an old artifact to production merely to obtain a new-format capture.

## Check portability and deployment behavior

Unified schema stores supported upload references as folder keys. Version 1 standalone files use instance-specific folder IDs. Verify every field that accepts uploads, including nested repeater fields and conditions. Extension-defined interface options are not automatically converted.

The unified workflow checks the source release and vendor. See [Source compatibility](/docs/manage/config-as-code/resources/schema/#source-release-and-vendor) before using `--force-schema` to override a mismatch.

Update automation for the unified [CLI options and exit codes](/docs/manage/config-as-code/cli/). In particular, deletions require `--destructive`, and a dry run with changes exits `1` rather than the standalone command's `0`.

## Keep the old workflow available during transition

Retain the original artifacts until the new tree has been reviewed and tested through staging. The [standalone schema reference](/docs/manage/schema-as-code/) remains available for existing deployments. `GET /schema/snapshot` remains supported, including consumers that inspect schema for SDK type generation.
