---
title: Import and export
description: Move data into and out of CairnCMS in bulk.
sidebar:
  order: 3
---

Use import and export when you need to move item data in or out of CairnCMS in bulk. This is useful for initial data loads, bulk edits outside the app, reporting workflows, and handoffs to other systems.

This guide covers the app workflow. CairnCMS also supports programmatic import and export through the API.

## What this feature does

Import and export work on item data in a collection.

Typical uses:

- bring in a CSV or JSON file from another system
- export filtered records for reporting or review
- move a subset of records into another tool for transformation

This feature does **not** export the entire database, and it does not replace backups.

## Import data

The app supports importing collection data from:

- CSV
- JSON

To import data:

1. Open the target collection.
2. Open **Import / Export** from the sidebar.
3. Choose the file to upload.
4. Start the import.

The imported rows are written as items in the current collection.

## Export data

Exports can be produced in:

- CSV
- JSON
- XML
- YAML

To export data:

1. Open the target collection.
2. Open **Import / Export** from the sidebar.
3. Choose **Export Items**.
4. Select the format.
5. Adjust any export options you need.
6. Start the export.

## Export controls

The export dialog can narrow both which items are exported and how they are serialized.

Common options include:

- export format
- row limit
- sort field and direction
- full-text search
- filter
- field selection and order
- export location

This is useful when you need a reporting subset rather than a full dump of the collection.

## Large exports

Small exports download directly to the local machine. Larger exports may be processed in batches and written to the File Library instead, with a notification when the export is ready.

That behavior is intentional. Large exports are treated as background work so the app does not have to stream everything through a single interactive request.

## Relations and file fields

Importing or exporting collections with relations requires more care than flat data.

Keep in mind:

- related values still depend on the existing relational structure
- the importing user needs the relevant permissions
- file references in a collection are not the same thing as importing or exporting the file bytes themselves

If you need to move the files themselves, use the File Library and storage workflows, not only collection import/export.

## When to use this versus the API

Use the app workflow when:

- the task is ad hoc
- a human is preparing or reviewing the file
- you want the quickest operational path

Use the API when:

- the process should be repeatable
- another system is driving the transfer
- the import or export needs to be part of a scripted workflow
