---
title: Apply output
description: Interpret human plans, versioned JSON, warnings, protections, step outcomes and run records.
sidebar:
  order: 7
---

Use the preview to review proposed changes. After apply, use the result to check what was completed. For scripts and deployment pipelines, use the JSON format below.

## Human plans

Changes are grouped by resource and operation. Schema appears as collections, fields and relations. Updates show changed attributes. Folder preparation lists referenced creations separately from remaining folder changes, without counting them twice in the summary.

Role deletions list affected permissions, bookmarks, users and sessions. Folder deletions list anything preventing deletion. Secret values are not printed.

A destructive refusal tells you to review the deletions and use `--destructive` if intended. Schema deletion identities in a refusal carry only a collection, so the remote CLI says `Delete schema in articles`, optionally with a change count. Use the dry-run plan to distinguish dropped fields, relations and collections.

## Machine-readable output

```bash
cairncms config apply ./config --dry-run --format json
```

Stdout contains one JSON document. Operational logs use stderr. Warnings remain in the document, not separate stdout messages. JSON is available only for dry runs.

An empty schema-managed plan has this shape:

```json
{
  "planVersion": 3,
  "manifestVersion": 3,
  "changes": [],
  "summary": { "create": 0, "update": 0, "delete": 0 },
  "warnings": [],
  "protections": []
}
```

`planVersion` is `3` when schema is managed and `2` otherwise. `manifestVersion` identifies the input format and can be `3` even when schema is not managed.

Each change has `kind`, `operation` and `identity`. Creates have `values`, updates have `fields`, and deletions have `impact` (empty where no impact entries are provided). Operations are `create`, `update` and `delete`.

| Change kind | Identity |
| --- | --- |
| `roles`, `folders` | `key` |
| `permissions` | `role`, `collection`, `action` |
| `settings` | `key: project` |
| `extension-settings` | `subject`, `scope`, `scope_key`, `key` |
| `translations` | `language`, `key` |
| `collections` | `collection` |
| `fields`, `relations` | `collection`, `field` |

Relations also carry `relatedCollection`, which can be null, on every operation. The three schema change kinds belong to the manifest's `schema` resource. They are not separate manifest kinds.

Update fields describe `before` and `after`. Schema changes may additionally use `beforePresent` and `afterPresent` to distinguish absent properties from present values. Global extension settings use an empty `scope_key`.

Optional `preparation` lists folder keys that will be created for schema upload fields. These creations are already included in `changes` and `summary`. The list is sorted and omitted when empty.

Consumers should ignore unknown additive properties but reject unsupported plan versions, change kinds and operations. Do not silently interpret an unfamiliar protection as permission to apply.

## Warnings and protections

| Warning code | Shape and meaning |
| --- | --- |
| `COLLECTION_MISSING` | `kind: permissions`, permission `identity`, `message`. A rule targets a missing collection |
| `UNCONFIGURED_TABLE_DROP` | `kind: collections`, `collection`, `message`. A table without collection metadata is planned for deletion |

Warnings do not block apply or change its exit code. Your deployment pipeline can require review when warnings are present.

Protection entries include `code`, `message` and contributing changes. `ADMIN_CONTINUITY_REQUIRED` prevents leaving no administrator role. It cannot be overridden with `--destructive`. Dry runs return the protected plan so a pipeline can inspect it. Mutation refuses it.

Source mismatch and invalid references are coded refusals rather than protection entries. A dry run may therefore refuse before returning any plan.

## Step outcomes

The step keys are `folders`, `schema` and `configuration`. The `configuration` step covers roles, permissions, folders, project settings, extension settings and translations. When the tree does not manage schema, `folders` and `schema` are `not_run`.

| Status | Meaning |
| --- | --- |
| `not_run` | The step was not reached |
| `skipped` | No work was applied for that step |
| `committed` | Commit is confirmed. Maintenance can still have failed afterward |
| `rolled_back` | That step did not retain changes |
| `failed` | The step failed. Inspect detail rather than assuming no writes |
| `unknown` | The step's persistence could not be established |

`failure.step` identifies the failed step. Its optional `detail` describes partial schema changes or a maintenance failure. Follow [Failure recovery](/docs/manage/config-as-code/recovery/) to decide what to check before retrying.

## Run record

Look for `config.run.finished` in the logs to investigate an apply or collect deployment results. It also records dry runs and refusals after a run starts. Fields include:

- `source`: `cli` for local runs, `http` for HTTP requests, including remote CLI requests.
- `caller`: system origin `config-cli` locally, or the authenticated HTTP caller where available.
- `manifestVersion`, `managedKinds`, `dryRun`, `destructive` and initial plan `changes` when available.
- `result`: `no_changes`, `planned`, `discarded`, `refused`, `invalid`, `state_changed`, `applied`, `post_apply_failed` or `failed`.
- `errorCode` on failures, or `UNEXPECTED` for an unclassified error.
- `steps` and `failure` when available, and `durationMs` for server/local work excluding transport.

For HTTP and remote CLI runs, match `runId` to the response's `X-Config-Run-Id` or the CLI's `Run <id>` line. HTTP records can also include `userAgent`. Local runs have no run ID.

The record is logged at `info` level. For local machine-readable records, use `LOG_STYLE=raw` with a log level that includes info. Failures before a run starts may have no record.

## Audit attribution

Changes to non-schema resources use the usual activity and revision records where supported. HTTP changes are attributed to the authenticated administrator. Local changes use the system origin `config-cli`.

Schema changes do not currently carry that per-change caller attribution. Use the HTTP run record to identify who initiated the apply, rather than expecting each schema event to name that administrator.
