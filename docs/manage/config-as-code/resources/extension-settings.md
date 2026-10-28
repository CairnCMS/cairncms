---
title: Extension settings
description: Manage declared values per extension subject while provisioning secrets separately.
sidebar:
  order: 5
---

Use config-as-code to manage extension settings in one file per extension package. The `subject` is the package name. Install the extension on the target before applying its settings.

Snapshot writes one file per eligible subject, including subjects without stored values. Keep its generated filename, which is checked against `subject`.

## Values and scopes

For an extension declaring the illustrated keys:

```yaml
subject: cairncms-extension-chat-notify
global:
  sender_name: CairnCMS
  api_token:
    $secret: preserve
collections:
  articles:
    channel: editorial
```

Global values belong under `global.<key>`. Collection-scoped values belong under `collections.<collection>.<key>`. Install the extension with matching setting declarations on the target. A collection must already exist or be created by the same tree. It cannot be one the tree deletes.

Ordinary values are strings, numbers or booleans with the declared type. Ordinary strings may use whole-value `{{CAIRNCMS_CONFIG_*}}` interpolation through the CLI. Other placeholder-like text is literal, except the environment-sourced references described below.

## Secrets

| Source | Authored value | Apply behavior |
| --- | --- | --- |
| Inline stored secret | `{ $secret: preserve }` | Keep the target value without copying it |
| Environment-sourced secret | Exact `{{CAIRNCMS_EXT_*}}` reference from snapshot | Supply the value through the target's environment |

Provision or rotate inline secrets through the admin app or admin API. The preserve marker does not supply a value for an unset secret.

Keep environment references exactly as emitted and configure the target environment separately. See [Extension secret settings](/docs/develop/extensions/settings/#secret-settings).

## Omission and clearing

Removing a subject's file stops managing that subject and leaves its values unchanged. Keeping a file makes it the complete desired set of that subject's declared stored values. Missing keys request deletion, including inline secrets and keys present only on the target. Omitted maps mean empty desired maps.

To clear all currently declared stored values, retain the generated file with:

```yaml
subject: cairncms-extension-chat-notify
global: {}
collections: {}
```

Review the deletion plan and authorize it with `--destructive`. A blank document or `{}` is invalid because `subject` is required.

This clears only currently declared stored values for that subject. It does not remove settings for uninstalled extensions, obsolete keys or environment-sourced secrets.
