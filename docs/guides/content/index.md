---
title: Content
description: Manage records, layouts, filters, imports, shares, and activity in CairnCMS.
sidebar:
  order: 1
---

The Content module is where most users spend their time in CairnCMS. It is the working surface for records in your collections: browsing them, opening individual items, adjusting layouts, filtering large datasets, importing and exporting data, sharing individual records, and reviewing recent activity.

This section focuses on the operational side of content work. It assumes the data model already exists. If you need to create collections, fields, or relationships first, start with the data model guides instead.

## What the Content module does

At a high level, the Content module gives you two kinds of pages:

- collection pages, where you browse many items at once
- item pages, where you inspect and edit one record at a time

Collection pages are built around layouts, sorting, search, filters, and bulk actions. Item pages are built around the form for that record, along with contextual tools such as comments, revisions, and shares.

The same collection can look different to different users. Roles and permissions decide:

- which collections are visible
- which fields appear
- which actions are allowed
- whether records can be shared, imported, exported, or modified

## What belongs here and what does not

The Content module is for working with records that already exist in the schema. It is not where you change the schema itself.

Use the Content module when you need to:

- browse or edit items
- switch layouts
- save a filtered view as a bookmark
- import or export item data
- create a share for one record
- review the activity feed

Use Settings instead when you need to:

- create or delete collections
- add or remove fields
- change relationships
- configure roles and permissions

## Typical workflow

A common content workflow looks like this:

1. Open a collection in the Content module.
2. Switch to the layout that fits the data best.
3. Search, sort, or filter to narrow the result set.
4. Open one item or select multiple items.
5. Edit the record, export a subset, create a share, or inspect related activity.

## Pages in this section

- [Layouts](/docs/guides/content/layouts/) explains the built-in collection views, display templates, and saved views.
- [Filters](/docs/guides/content/filters/) covers the visual filter builder, nested groups, dynamic variables, and relational filtering.
- [Import and export](/docs/guides/content/import-export/) covers moving record data in and out of CairnCMS in bulk.
- [Shares](/docs/guides/content/shares/) explains how to grant read-only access to individual records.
- [Activity log](/docs/guides/content/activity-log/) covers the system-wide record of data-changing actions.
