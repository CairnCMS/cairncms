---
title: Project settings
description: Supported project settings, omission and null semantics, and the default storage folder.
sidebar:
  order: 4
---

Project settings use one required document, `settings/project.yaml`. Include the fields you want to manage. Omitting an optional field leaves its target value unchanged.

For example:

```yaml
project_name: '{{CAIRNCMS_CONFIG_PROJECT_NAME}}'
default_language: en-US
storage_default_folder: article_images
```

With the CLI, define `CAIRNCMS_CONFIG_PROJECT_NAME` before apply. For direct HTTP, send the resolved project name. The folder value is a key, not a database ID.

## Supported fields

| Fields | Type |
| --- | --- |
| `project_name`, `default_language` | String. Cannot be null |
| `project_descriptor`, `project_url`, `project_color`, `public_note`, `custom_css` | String or null |
| `auth_password_policy`, `mapbox_key` | String or null |
| `auth_login_attempts` | Non-negative integer or null |
| `storage_asset_transform` | `all`, `none`, `presets`, or null |
| `module_bar`, `storage_asset_presets`, `basemaps`, `custom_aspect_ratios` | Array of objects or null |
| `storage_default_folder` | Folder key or null |

Only the fields listed above are supported.

Set a nullable field to `null` to clear it. Arrays and their nested values are supplied as values, not patches. Start from a snapshot rather than reconstructing complex asset or module settings by hand.

Only `project_name`, `project_descriptor`, `project_url` and `mapbox_key` accept CLI environment placeholders. The default folder does not. See [Environment placeholders](/docs/manage/config-as-code/resources/#environment-placeholders).

## Default storage folder

When folders are managed, `storage_default_folder` must name a declared folder. Otherwise it must already exist on the target. Set it to `null` to clear the default or to another key to retarget it before deleting its former folder.
