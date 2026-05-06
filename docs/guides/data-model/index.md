---
title: Data model
description: How CairnCMS organizes collections, fields, and relationships.
---

The data model is the structure of your data: the collections you store, the fields inside them, and the relationships between them. In CairnCMS, the data model is your SQL schema, plus the metadata CairnCMS uses to present and manage it.

This page covers the conceptual shape of the data model, the decisions when designing one, and how CairnCMS terms map to standard relational concepts.

## Database terms and CairnCMS terms

At the database level, your schema is made of tables, columns, primary keys, foreign keys, and rows. CairnCMS works with the same structure but exposes it through more user-friendly names:

- a **table** is a **collection**
- a **column** is a **field**
- a **row** is an **item**
- a **foreign key relationship** is a **relationship**

These names are easier for non-developers to use, but the underlying structure is still relational and still lives in standard SQL tables. You can inspect, query, back up, and migrate the database directly at any time.

## Building the model

There are two normal ways to end up with a CairnCMS data model:

- create collections and fields in the app, under **Settings > Data Model**
- point CairnCMS at an existing SQL schema and let it reflect what is already there

CairnCMS works with whatever database you control instead of forcing data into a separate content store.

## Relational design still matters

The app makes schema work easier. It does not remove the need for clear modeling decisions.

The main questions are still:

- what should be its own collection
- what should be a field on an existing collection
- when should data be normalized into related tables
- which fields should be required, unique, or indexed
- which collections should be singleton-like versus multi-record

A polished admin app does not fix a bad schema. CairnCMS helps you configure a model but it does not decide the business model for you.

## Avoid duplication when a relationship would do

One of the most common modeling mistakes is storing the same fact in multiple places. For example, if `articles` need author information, it is usually better to relate `articles` to `authors` (or `users`) than to copy the author name, email, and profile details into every article row. Duplicated values drift over time. Relationships keep one source of truth.

The schema can stay expressive without repeating the same data everywhere. That is the practical advantage of relational modeling.

## Collection metadata

Beyond the raw table shape, a collection carries metadata that controls how it appears in the app:

- icon and color
- display template
- hidden versus visible in navigation
- singleton behavior
- sort field for manual ordering
- archive field for soft-delete
- accountability tracking (activity and revisions, activity only, or neither)
- grouping under folders

These settings do not change the relational fundamentals, but they do change how the collection behaves inside the admin app.

## System collections and domain collections

CairnCMS keeps its own state in system collections such as users, roles, permissions, dashboards, flows, and presets. Your application data lives in your own collections alongside that system metadata, but the two serve different purposes:

- domain collections model your actual business or content data
- system collections power the platform itself

You will interact with both, but most schema design work is about the domain collections.

## Common modeling patterns

A few patterns come up repeatedly when modeling CairnCMS projects:

- **single-record settings** collections that behave as singletons (for example, site settings or contact details)
- **lookup tables** such as countries, statuses, or categories
- **junction collections** for many-to-many relationships
- **translation collections** for multilingual content
- **file-linked collections** where records point to assets in the file library

These are standard relational patterns that the app makes easier to build and manage.

## Where to go next

The next two pages cover the parts of the model you will work with most directly:

- [Fields](/docs/guides/data-model/fields/) covers how fields are organized, the categories in the **Create Field** drawer, and the storage types behind them.
- [Relationships](/docs/guides/data-model/relationships/) covers the relationship types CairnCMS supports and how each one shapes the schema.
