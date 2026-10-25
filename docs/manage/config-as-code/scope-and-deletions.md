---
title: Managed scope and deletions
description: Which omissions preserve state, which request deletion, and what destructive authorization does.
sidebar:
  order: 3
---

The manifest's `resources` list declares which kinds the tree manages. Omitting a kind leaves it alone. Listing a kind can make missing records deletion requests, even when a file was removed accidentally.

## Read omissions at the correct level

| Scope | Omission means |
| --- | --- |
| Kind absent from `resources` | Do not manage that kind |
| Role, permission rule, folder or translation absent from a managed kind | Plan its deletion |
| Collection, field or relation absent from managed schema | Plan deletion within the captured schema boundary |
| Extension subject file absent | Stop managing that subject. Preserve its values |
| Stored declared setting absent within a managed extension subject | Plan its deletion |
| Optional project-setting field absent | Preserve the target value |
| Optional role field absent | Preserve where the role format permits omission |
| Direct property absent inside an existing schema `meta` or `schema` object | Preserve it. See the schema omission rules linked below |

`resources: []` manages nothing. Keep generated filenames and use `.yaml`. Files with unrecognized names or extensions can be skipped and count as omitted records. See [Files the reader skips](/docs/manage/config-as-code/resources/#files-the-reader-skips).

Removing a collection file does not exclude its table from management. It requests deletion. See [Schema](/docs/manage/config-as-code/resources/schema/) for which tables and fields are included.

## Use complete desired sets

Start from a generated snapshot and retain every record you intend to keep. All permission files together form the complete desired set when permissions are managed. Removing a language file from managed translations requests deletion of that language's custom strings.

For [extension settings](/docs/manage/config-as-code/resources/extension-settings/), removing a file preserves its subject's values. Keeping it with empty maps clears declared stored values.

Keep schema `meta` and `schema` objects as captured. If you need a [direct file edit](/docs/manage/config-as-code/resources/#when-to-edit-files), follow the resource's omission rules. See [Schema omission rules](/docs/manage/config-as-code/resources/schema/#omitted-properties).

## Authorize intended deletions

```bash
cairncms config apply ./config --dry-run
cairncms config apply ./config --destructive
```

The second command permits planned deletions after confirmation. Over HTTP use `destructive=true`. Without authorization a mutating deletion plan is refused. Dry runs still show deletions and protections.

The flag does not gate every risky update. Changing a column type, narrowing a value, or overwriting a target's settings can lose information without being a deletion. Neither `--destructive` nor `--force-schema` overrides administrator-continuity protection or invalid references.

## Review consequences beyond the deleted record

Deleting a role removes its permissions and presets and suspends and unassigns its users. Those effects reach outside managed kinds. The preview includes affected permissions, bookmarks, users and sessions.

Dropping a collection or field can destroy its data. Check applications, saved queries and permissions that depend on it.

Config-as-code does not move files out of a deleted folder. Move its files and children, and update settings or fields that reference it, before deleting it. See [Folders](/docs/manage/config-as-code/resources/folders/).

## Warnings and protections

Warnings do not themselves block apply or change its exit code. `UNCONFIGURED_TABLE_DROP` identifies a planned drop of a table not configured as a CairnCMS collection. It may contain another application's data.

Protections refuse mutation even with destructive authorization. `ADMIN_CONTINUITY_REQUIRED` prevents removal of the last administrator role. A run can transfer administrator access between roles while preserving continuity.

For machine-readable warning and protection codes, see [Apply output](/docs/manage/config-as-code/output/). For a refused apply, follow [Failure recovery](/docs/manage/config-as-code/recovery/).
