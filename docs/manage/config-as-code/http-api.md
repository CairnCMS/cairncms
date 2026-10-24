---
title: HTTP API
description: Snapshot and apply a complete config-as-code document through administrator-only HTTP endpoints.
sidebar:
  order: 6
---

The config-as-code endpoints require an authenticated administrator. Snapshot returns a document you can edit and preview. Apply accepts that whole document in one request. For directory handling, use the [CLI](/docs/manage/config-as-code/cli/).

## Retrieve a snapshot

```text
GET /config/snapshot
GET /config/snapshot?export=yaml
GET /config/snapshot?manifest_version=3&resources=folders,schema
```

The default is manifest version 3 and all kinds supported by that version. `resources` is a comma-separated list. `resources=` selects none. Unsupported versions/kinds, malformed resource lists and repeated scope parameters are refused.

JSON returns the document under `data`. `export=yaml` returns a YAML attachment. Send the document itself to apply, not the snapshot's outer `{ data: ... }` envelope.

The document contains `manifest` and one array for every kind supported by its manifest version. Keep those arrays even for unmanaged kinds. A version 3 settings-only document can be:

```json
{
  "manifest": { "version": 3, "resources": ["settings"] },
  "roles": [],
  "permissions": [],
  "folders": [],
  "settings": [{ "project_name": "Editorial" }],
  "extension-settings": [],
  "translations": [],
  "schema": []
}
```

This updates only the project name. The empty arrays do not delete unmanaged kinds. By contrast, listing a complete-set kind in `resources` makes an empty array a deletion instruction for its records.

## Preview and apply

```text
POST /config/apply?dry_run=true
POST /config/apply
POST /config/apply?destructive=true&force_schema=true
```

Send JSON with `application/json`, or YAML with `application/yaml`, `application/x-yaml` or `text/yaml`. The endpoint does not accept the CLI directory as an upload. Environment placeholders such as `{{CAIRNCMS_CONFIG_PROJECT_NAME}}` are refused with `400 CONFIG_INVALID`. Resolve them before sending the document. Preserve declared `CAIRNCMS_EXT_*` runtime references verbatim.

| Query flag | Default | Meaning |
| --- | --- | --- |
| `dry_run` | `false` | Validate and return the plan without writing |
| `destructive` | `false` | Authorize planned deletions |
| `force_schema` | `false` | Waive missing/mismatched schema source release/vendor |

Flags accept exactly `true` or `false`. Repeated or other values return `400 CONFIG_INVALID`.

Review the dry-run plan before sending the same document without `dry_run`. The preview shows deletions and protections, but invalid input or missing references can prevent it from completing. Apply compares the document with the target again.

## Success envelopes

A dry run returns `{ "data": plan }`. The [plan format](/docs/manage/config-as-code/output/#machine-readable-output) includes `changes`, `summary`, `warnings` and `protections`.

A mutating success returns `data` and `meta`:

| Field | Meaning |
| --- | --- |
| `meta.plan` | Initial intended changes, including schema and preparation |
| `meta.result` | `applied` if any step committed. Otherwise `no_changes` |
| `meta.steps` | `folders`, `schema`, `configuration` statuses |
| `data` | Changes applied to non-schema resources. Null when a schema-managed run skipped the `configuration` step |

For a tree without schema, a no-op returns an empty result object, with `folders` and `schema` marked `not_run` and `configuration` marked `skipped`. A schema-only apply can return `data: null` while `schema` is `committed`. Null data is not proof of a no-op. A schema-managed no-op reports all three steps `skipped` and `no_changes`.

Non-null results have role/folder key arrays (`created`, `updated`, `deleted`) and permission/extension-setting/translation counts. `settings.updated` is `["project"]` when project settings changed, or `[]` otherwise. It does not list individual setting names. The `schema` counts are empty. Use `meta.steps.schema` for the schema outcome. Prepared folders are not repeated in `data.folders.created`.

Use `meta.result` and `meta.steps` to determine what was applied. Result counts can differ from the initial preview for a schema-managed run.

## Errors and partial outcomes

Errors use the normal `errors` array with `message` and `extensions.code`. When available, `extensions.steps` reports the step states and `extensions.failure` identifies the failed step and its details. Early validation errors may lack those fields.

A failed request can leave changes applied, including when its HTTP status is `400` or `409`. Inspect the outcome and follow [Failure recovery](/docs/manage/config-as-code/recovery/) before retrying.

`DESTRUCTIVE_CHANGES_REQUIRED` lists deletions. Schema entries identify only the collection, so a field drop and a collection drop are not distinguishable from that identity alone. Use a dry run for precise schema changes. Administrator-continuity refusals include `extensions.protection.code: ADMIN_CONTINUITY_REQUIRED` and contributors.

## Correlation and payload size

Use `X-Config-Run-Id` to find the matching server [run record](/docs/manage/config-as-code/output/#run-record). Requests rejected before a run starts may have neither.

Requests are subject to the server's `MAX_PAYLOAD_SIZE`. Configure an appropriate bound for large reviewed trees. Do not split a schema-managed desired tree into arbitrary chunks to bypass it: omitted collections can become deletions.

If the request outlasts the client or proxy deadline, follow [Failure recovery](/docs/manage/config-as-code/recovery/#lost-or-unverifiable-response).
