---
title: Files and resources
description: Manifest versions, file identities, snapshot behavior, and environment placeholders.
sidebar:
  label: Overview
  order: 0
---

A config-as-code directory contains a manifest and YAML files for the resources it manages. Make changes on the source instance, capture a snapshot, review the files, and apply them to the target.

## The manifest

`cairncms-config.yaml` selects the format and managed kinds. For example, a captured schema-and-folders tree might contain:

```yaml
version: 3
resources:
  - folders
  - schema
schema:
  release: 1.7.0
  vendor: postgres
```

Use the release and vendor recorded by your source, not these illustrative values. The `schema` header records where the schema was captured. It is allowed only when schema is managed. Apply checks it against the target. See [Schema](/docs/manage/config-as-code/resources/schema/).

| Manifest version | Available kinds |
| --- | --- |
| 1 | `roles`, `permissions` |
| 2 | Version 1 kinds plus `folders`, `settings`, `extension-settings`, `translations` |
| 3 | Version 2 kinds plus `schema` |

A new directory defaults to version 3 and all seven kinds. Re-snapshotting an existing directory preserves its version and resource list. Pre-create a manifest to select a narrower scope. `resources: []` is an explicitly empty scope.

Manifest versions are separate from the [JSON plan version](/docs/manage/config-as-code/output/) and [standalone schema snapshot version](/docs/manage/schema-as-code/).

## Directory layout

```text
config/
  cairncms-config.yaml
  roles/administrator.yaml
  roles/editor.yaml
  permissions/editor.yaml
  permissions/public.yaml
  folders/article_images.yaml
  settings/project.yaml
  extension-settings/cairncms-extension-chat-notify-11fe5f91.yaml
  translations/fr-FR.yaml
  schema/articles.yaml
```

Only selected kinds are managed. Role and folder filenames match their `key`. Permission filenames match `role`. Translation filenames match `language`. Public permissions have no corresponding role document. Extension filenames must match the generated name for their `subject`.

For schema, the `collection` property identifies the collection. Keep the generated filename. Renaming the file does not rename the collection.

### Files the reader skips

Use `.yaml` and the generated naming pattern. Unrecognized `.yaml` filenames are skipped with a notice. Other extensions, including `.yml`, are skipped silently. A missing resource directory counts as empty. Managed settings instead require `settings/project.yaml`.

A skipped record can be planned for deletion, including a collection or field. Read notices and review the dry run before granting `--destructive`. Do not rename files to temporarily exclude records you want to keep.

Read [Managed scope and deletions](/docs/manage/config-as-code/scope-and-deletions/) before removing files or directories.

## Snapshotting an existing directory

Save pending edits before snapshotting again. Snapshot replaces managed files with the source's current state and removes records no longer present there. It prompts before overwriting a non-empty directory. `--yes` skips that prompt.

Symlinks must point inside the config-as-code directory. Broken or escaping links stop the command.

## When to edit files

Reserve hand-editing for specific needs, such as choosing manifest scope, adding environment placeholders, supplying [extension secrets](/docs/manage/config-as-code/resources/extension-settings/#secrets), and following the [migration guide](/docs/manage/config-as-code/migration/). For routine changes to schema or other managed resources, update the source instance and capture again.

If a special circumstance requires editing resource files directly, follow that resource's field and omission rules. Review the full preview and test the edited tree on a disposable instance. After applying, confirm that another dry run reports no changes before deploying the files elsewhere.

## Environment placeholders

CLI interpolation supports whole-value placeholders in role names/descriptions, project name/descriptor/URL/Mapbox key, and ordinary extension-setting strings:

```yaml
project_name: '{{CAIRNCMS_CONFIG_PROJECT_NAME}}'
```

Set the variable in the CLI process, including when it connects remotely. An unset supported placeholder stops the command. The HTTP API refuses these placeholders with `400 CONFIG_INVALID`. Direct callers must resolve them before sending the document.

An existing supported placeholder is retained when snapshotting into the same directory, even if unset or different from the database. A new directory and an HTTP snapshot contain stored ordinary values instead.

Role/project placeholders outside `CAIRNCMS_CONFIG_` are invalid. In an ordinary extension-setting string, other placeholder-like text is literal, except reserved `CAIRNCMS_EXT_*` references. Keep those references only where the extension declares environment-sourced settings.

Folder fields, schema fields and translations do not support this interpolation. Extension secrets use their separate [secret contract](/docs/manage/config-as-code/resources/extension-settings/#secrets), not ordinary-value interpolation.
