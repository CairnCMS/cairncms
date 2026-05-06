---
title: Files
description: Upload, organize, and manage files through the File library and use them in collections.
sidebar:
  order: 7
---

The File library is the built-in module for working with file assets: images, videos, PDFs, documents, anything you upload. It is reached from the file icon in the module bar.

CairnCMS tracks file metadata in the database (record IDs, names, types, dimensions, folders, custom fields) while storing the file contents on the configured storage backend. The two layers are independent: the same file metadata can be served from local disk, S3-compatible object storage, Google Cloud Storage, Azure Blob Storage, or Cloudinary depending on how the instance is configured.

## Uploading files

Files can be uploaded in several ways:

- **Drag and drop** onto the upload area on a folder page or onto a file field on an item page
- **Click the upload area** to pick a file from the local filesystem
- **Import from URL**, which fetches a remote file and stores it as a new asset
- **Choose an existing file** from the library when filling in a file or image field on a record

Multiple files can be uploaded at once. There is no restriction on file type. Anything from images and PDFs to arbitrary binaries can be stored.

A file uploaded directly through the File library lands in whatever folder is currently open. A file uploaded through a file or image field on a record can also be placed into a default folder configured on that field.

## Files in collections

Files are used in collections through three relational field options:

- **File** — links one record to a single file
- **Image** — like File, but with image-oriented display options such as a default folder, crop fitting, and inline image preview. The relation itself is the same as File, and non-image files still work but render as a generic icon
- **Files** — links one record to many files (creates a many-to-many junction collection behind the scenes)

The link is stored as a foreign key. The actual bytes stay in the file library and are referenced by record ID.

When you create a file relation, the field's `On Delete` constraint defaults to `SET NULL`. This means deleting a file clears the reference on any items that pointed to it. The items themselves are preserved with a null file field. To change that behavior, set the relational `On Delete` constraint on the field to `CASCADE` (delete the related items along with the file) or `NO ACTION`/`RESTRICT` (block file deletion while it is still referenced).

## Browsing files and folders

The File library page lists files in the current folder. It uses the same controls as a collection page: search, filter, sort, layout, and bulk actions. The cards layout works well for image-heavy folders, while the table layout is better for mixed file types or when you want to see every metadata column at once.

Folders provide the organization structure. The folder navigation appears in the navigation pane to the left of the file listing. Folders can be nested arbitrarily deep.

### Creating a folder

Click the new-folder button in the page header, name the folder, and save. Folders can also be created as children of an existing folder.

### Renaming, moving, and deleting folders

Right-click a folder in the navigation pane to access:

- **Rename Folder**
- **Move to Folder**
- **Delete Folder**

When a folder is deleted, any nested files and folders inside it are moved up one level rather than being removed. This means deleting a folder is non-destructive for the files it contains.

## The file detail page

Clicking a file opens its detail page. This is a normal item page backed by the `directus_files` system collection, with built-in fields and a sidebar of derived metadata.

### Built-in fields

These fields ship with every file record. They cannot be removed, but additional custom fields can be added through **Settings > Data Model**.

- **Title** — a human-readable title
- **Description** — a longer description
- **Tags** — keywords for search and filtering
- **Location** — an optional location, useful for photos
- **Storage** — which storage backend the file is on (read-only)
- **Filename (Disk)** — the actual filename in storage (read-only)
- **Filename (Download)** — the filename shown when the file is downloaded

### Sidebar metadata

The sidebar shows derived information that is not directly editable:

- **Type** — the MIME type
- **Dimensions** — width and height in pixels (images only)
- **Size** — file size in storage
- **Created** — upload timestamp
- **Owner** — the user who uploaded the file
- **Modified** — last-modified timestamp
- **Edited By** — last user to modify the record
- **Folder** — the parent folder
- **Metadata** — a JSON dump of EXIF, IPTC, and ICC data extracted from the file

## Editing an image

The file detail page has an image editor for basic transformations: rotate, crop, flip, and aspect ratio. Open it with the editor button in the page header.

Image edits **overwrite the original file on disk**. They are not reversible from inside CairnCMS. Keep an original somewhere else if you need to roll back.

## Replacing a file

A file can be replaced with new contents while keeping the same record. Existing metadata, custom fields, and relationships to other items are preserved; only the bytes change.

Open the file detail page and click the **Replace File** button near the preview. A dialog opens with the upload control. Drag-and-drop, file picker, and import-from-URL all work the same way as for new uploads.

## Storage backends

Where the file bytes live is set by the operator at deploy time. CairnCMS supports local disk, S3-compatible object storage, Google Cloud Storage, Azure Blob Storage, and Cloudinary. Multiple backends can be configured on a single instance, and individual files can be stored on different backends.

The Storage field on a file record shows which backend that file is on. It is read-only from the app. Moving files between backends is an operator task, not an editor task.

For configuration of storage backends, see the deployment and configuration sections under Manage.

## Where to go next

- [Permissions](/docs/guides/permissions/) covers how to scope which users can read, upload, edit, or delete files.
- [Data model](/docs/guides/data-model/) covers how to add file relations to a collection.
