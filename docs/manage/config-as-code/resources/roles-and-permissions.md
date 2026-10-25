---
title: Roles and permissions
description: Stable role keys, complete permission sets, and the consequences of deleting access-control records.
sidebar:
  order: 2
---

Roles and permissions are independently selectable kinds. When both are managed, permissions reference roles declared in the tree. When only permissions are managed, role keys must already exist on the target.

## Role documents

`roles/editor.yaml`:

```yaml
key: editor
name: Editor
admin_access: false
app_access: true
```

This is one record, not a complete role set. If roles are managed, retain every other role you intend to keep, including an administrator.

| Field | Contract |
| --- | --- |
| `key` | Required stable identity. At most 246 lowercase letters, digits and underscores, beginning with a letter. No consecutive underscores. Filename must match. Cannot be `public` |
| `name` | Required string of at most 100 characters. Supports CLI interpolation |
| `admin_access`, `app_access` | Required booleans |
| `icon` | Optional string of at most 30 characters. Omission preserves the existing value. Not nullable |
| `enforce_tfa` | Optional boolean. Omission preserves the existing value. Not nullable |
| `description` | Optional string or null. Supports interpolation |
| `ip_access` | Optional array of IP strings or null |

Omitting `description` or `ip_access` preserves the target value. Set them to `null` to clear. Keep the key when renaming a role. Changing it creates a different identity and can plan deletion of the original.

For a new role, omitted `icon` defaults to `supervised_user_circle`, `enforce_tfa` to `false`, and `description` and `ip_access` to `null`.

## Permission documents

`permissions/editor.yaml` can contain:

```yaml
role: editor
permissions:
  - collection: articles
    action: read
    permissions:
      status:
        _eq: published
    validation: null
    presets: null
    fields:
      - id
      - title
```

Each rule requires `collection`, `action`, `permissions`, `validation`, `presets` and `fields`. Policy values are objects or null. `fields` is a string array or null. Preserve the generated meaning of null rather than treating it as an empty allow-list. Supported actions are `create`, `read`, `update`, `delete`, `comment`, `explain` and `share`.

One role may have only one rule for a collection/action pair. All files form the complete desired permission set. Omitted rules request deletion.

Public access uses `permissions/public.yaml` with `role: public`. Do not create `roles/public.yaml`.

You can prepare permissions for a collection that does not exist yet. The preview warns about the missing collection, but apply allows the rule.

## Deletion and administrator continuity

Deleting a role also removes its permissions and presets, suspends and unassigns its users, and affects their sessions. These consequences apply even if those resources are not managed by the manifest. Review the cascading impacts in the preview.

The instance must retain an administrator role. `ADMIN_CONTINUITY_REQUIRED` prevents removing the last one, even with `--destructive`. You can transfer administrator access between roles in the same apply.

See [Permissions](/docs/guides/permissions/) for help designing access rules.
