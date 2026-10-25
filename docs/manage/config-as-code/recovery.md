---
title: Failure recovery
description: Inspect a failed apply, correct the problem and decide whether to retry or restore a backup.
sidebar:
  order: 8
---

An apply can fail after making changes. Before retrying, inspect the target and decide whether to complete the deployment or restore a backup.

## Preserve the desired tree and inspect the target

Keep the reviewed files, error message and any run ID. Pause competing administrative changes while investigating. If the response was lost, first check whether the server is still processing the apply.

Capture the current target into a separate, new directory:

```bash
cairncms config snapshot ./target-inspection --url https://cms.example.com
```

For a focused comparison, copy the reviewed tree's manifest into the inspection directory before capture and add `--yes`. Otherwise a fresh directory captures all supported kinds.

Do not capture over the reviewed tree. Compare the new snapshot with it and check the affected application and data. If you intend to finish the deployment, run a fresh dry run and review the remaining changes first.

## Read the step states

| Report | Next action |
| --- | --- |
| All steps `not_run` | Correct the reported problem and preview again |
| Folders `committed`, schema failed | Keep or deliberately clean up the prepared folders. Inspect schema before retrying |
| `schema` committed, `configuration` failed | Preview the remaining resource changes. The schema changes remain applied |
| Any `unknown` result | Verify the affected database objects and data before deciding to retry |
| Step `committed` with maintenance failure | Follow the maintenance guidance below. Do not repeat schema changes just to obtain a success response |

`rolled_back` applies only to the named step. Earlier successful steps remain applied. If a step says `failed` without further detail, inspect the target rather than assuming it was unchanged.

## Common refusals

| Code | HTTP status | What to check |
| --- | --- | --- |
| `CONFIG_INVALID` | `400` | Correct the named field, missing reference or document shape |
| `CONFIG_UNSUPPORTED_VERSION` | `400` | Select a format and resource scope supported by this release |
| `CONFIG_IDENTITY_CONFLICT` | `400` | Remove duplicate identities rather than relying on file order |
| `CONFIG_PLACEHOLDER_UNRESOLVED` | CLI interpolation | Supply the required CLI environment variable |
| `CONFIG_SCHEMA_SOURCE` | `400` | Align releases/vendors or deliberately use the narrowly scoped schema override |
| `DESTRUCTIVE_CHANGES_REQUIRED` | `400` | Review deletions, then authorize only intended ones |
| `CONFIG_PROTECTED_RECORD` | `400` | Preserve administrator continuity. Overrides cannot waive it |
| `CONFIG_FOLDER_IN_USE` | `400` | Move/clear the named files, children or references |
| `CONFIG_STATE_CHANGED`, `SCHEMA_STATE_CHANGED` | `409` | Stop competing writes and review a fresh plan |

Read the step outcomes alongside the error. An HTTP `400` or `409` does not rule out earlier changes in the same apply.

## Partial schema persistence

For `SCHEMA_APPLY_FAILED`, check the reported collections, fields and relations against the database. Some changes can remain, especially on MySQL and MariaDB.

HTTP responses put this report in `extensions.failure.detail.persisted` when available. Individual results are `applied`, `reverted`, `unknown` or `not_applicable`. Update results and relation foreign-key results are always `unknown` and need manual verification. Do not assume that a table's status also describes all its columns and metadata.

If `foreignKeysRestored` is `false`, restore foreign-key enforcement before resuming normal traffic. Ask a database administrator for help if you cannot verify it.

`CONFIG_APPLY_FAILED` reports a rolled-back `configuration` step. It does not undo schema or folder changes from earlier in the run.

## Post-commit maintenance

`CONFIG_POST_COMMIT_FAILED` and `SCHEMA_POST_COMMIT_FAILED` mean changes were saved, but cache updates, event delivery or database maintenance failed afterward. Check `extensions.phase` or `failure.detail.phase` and address that problem:

| Phase | Recovery focus |
| --- | --- |
| `cache` | Clear affected cache state using the administrator `POST /utils/cache/clear` endpoint and verify deployment health |
| `actions` | Identify hooks/flows that may not have received events. Handle replay according to their side effects |
| `cache_and_actions` | Both cache and event-delivery checks |
| `foreign_keys` | Verify and restore foreign-key enforcement with database-aware assistance |
| `foreign_keys_and_cache` | Restore enforcement and repair cache state |

Reapplying an unchanged tree does not repair missed maintenance. Check whether an event already triggered an external action before replaying it.

## Lost or unverifiable response

A timeout can occur while the server is still applying changes or after it has finished. Use the run ID to check server logs, then inspect the target. Missing logs do not establish that nothing happened.

The remote CLI exits `3` when it cannot establish the result of an apply. This includes a response it cannot verify. Follow the inspection procedure above before retrying. A failed dry run has not submitted a write.

## Repairing stored values

If `CONFIG_READ_FAILED` names an unreadable target record, correct it on the target before retrying.

If an error names a field that references a missing folder, repair its upload-folder setting on the target. Select an existing folder or clear the reference if uploads no longer need that destination. Then retry the capture or preview.

For an extension setting with the correct scope and a valid collection, correct its value in the admin app or send administrator `POST /extension-settings` with `{ subject, scope, scope_key, key, value }`.

For an obsolete scope or missing collection, remove the exact stale row with administrator `DELETE /extension-settings` and `{ subject, scope, scope_key, key }`. Saving a new value under another scope does not delete the obsolete row. `GET /extension-settings` omits rows with unparseable stored JSON, so the reported row may be absent from that listing.

For a malformed translation, inspect administrator `GET /translations` for the named language, then correct or remove the exact row. Do not clear a whole managed kind as a shortcut for repairing one unreadable record.
