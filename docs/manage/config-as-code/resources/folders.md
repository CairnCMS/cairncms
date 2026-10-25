---
title: Folders
description: Capture folder names and hierarchy, reference upload folders, and remove unused folders.
sidebar:
  order: 3
---

Folder documents transfer file-library organization, not uploaded files. A stable key identifies a folder across instances even though its database ID differs.

## Describe the hierarchy

`folders/article_images.yaml`:

```yaml
key: article_images
name: Article images
parent: null
```

`key` and `name` are required. Keys use lowercase letters, digits and underscores, beginning with a letter. Consecutive underscores are not allowed. Keys are at most 246 characters and names at most 255. Keep the key when renaming or moving a folder. The filename must match it.

| `parent` | Effect |
| --- | --- |
| Another declared folder's key | Place it under that folder |
| `null` | Move it to the root |
| Omitted | Preserve an existing parent. Create a new folder at the root |

A folder cannot be its own ancestor. Folder fields do not support environment interpolation. Use `GET /folders?fields=id,name,key` with an administrator token to look up keys.

## Use folders in upload fields

Upload fields refer to folders by key. Include missing folders and their parent hierarchy in the tree, with `folders` selected in the manifest. Apply creates the required folders before the fields that use them.

If the tree manages only schema, its referenced folders must already exist on the target. See [Schema upload folders](/docs/manage/config-as-code/resources/schema/#upload-folders) for supported interfaces.

## Deleting folders

When folders are managed, omission requests deletion. Unlike folder deletion in the admin app, config-as-code does not relocate a folder's files.

Before deletion, move or remove files, move or delete child folders, and update settings and fields that reference the folder. You can update a reference and delete its former folder in the same tree.

The preview can still list `options.folder` as a blocker when that same tree moves the field's reference elsewhere. Check the planned field change. Apply can delete the folder once the reference has moved.

If apply returns `CONFIG_FOLDER_IN_USE`, resolve the item named in `extensions.blockedBy` and preview again.
