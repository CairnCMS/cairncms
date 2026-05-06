---
title: Glossary
description: Definitions for terms used throughout the CairnCMS docs.
---

This page defines CairnCMS terms that appear throughout the docs. Most of them are ordinary database or application concepts with CairnCMS-specific names layered on top.

## Activity Log

The activity log records actions that pass through CairnCMS, including create, update, delete, comment, and login events. Entries include the action type, actor, timestamp, IP address, user agent, and the item or collection involved.

## Administrator

An administrator is a user whose role has **Admin Access** enabled. Admin roles bypass normal permission checks and can manage system settings in the admin app.

## Alias Field

An alias field is a field that does not map directly to a database column. It exists in the CairnCMS model for presentation or relational purposes.

Examples include presentation fields such as groups and dividers, and relational fields whose displayed value is stored elsewhere.

## API

The API is the programmatic interface CairnCMS exposes over your data and system metadata. External applications, scripts, and services use the REST or GraphQL API to read and write data.

## App

The app is the browser-based admin interface. It is where users manage records, files, dashboards, permissions, flows, and system settings.

The app is not a separate source of truth. It uses the same underlying services as the API.

## Bookmark

A bookmark is a named preset that appears in the app navigation as a saved view. In practice, bookmarks are presets with a user-facing label and a direct navigation target.

## Collection

A collection is a named set of records. In database terms, a collection usually maps to a table.

Collections define the structure CairnCMS works with. Each collection contains fields, can participate in relationships, and has a primary key.

## Dashboard

A dashboard is a saved workspace in the Insights module that groups one or more panels into a single view.

## Database Abstraction

CairnCMS works across multiple SQL vendors by translating its internal model into vendor-specific database behavior. This abstraction layer is what lets the platform support PostgreSQL, MySQL, MariaDB, and SQLite without exposing every database-specific difference to the rest of the system.

## Display

A display controls how a field value is shown in the app when it is being viewed rather than edited.

For example, a boolean might render as an icon, a date might render in a formatted style, and a relation might render as a label or title.

## Environment

An environment is a separate CairnCMS instance used for a specific stage of work, such as development, staging, or production.

## Extension

An extension adds custom behavior to CairnCMS without patching core. Supported extension types include interfaces, displays, layouts, modules, panels, hooks, endpoints, operations, themes, migrations, bundles, and email templates.

## Field

A field is a single named value inside a collection. In database terms, a field usually maps to a column.

Fields define what data a record can store, such as a title, status, publish date, or relation to another collection.

## Files

Files are assets managed through CairnCMS, such as images, videos, PDFs, and documents. CairnCMS stores file metadata in the database and stores the file contents on a configured storage backend.

## Instance

An instance is one running CairnCMS deployment. It includes the application, its database connection, storage configuration, and any installed extensions.

In practice, teams often run multiple instances for different environments such as development, staging, and production.

## Interface

In CairnCMS, an **interface** is the component type that powers a field's editing experience in the app. It appears as an extension type for adding new editing components, as a section in the field configuration drawer where you configure the experience for a single field, and as the items shown in the **Create Field** drawer — each one is an interface preset paired with a sensible default type.

## Item

An item is one record inside a collection. In database terms, an item usually maps to a row.

Items are the unit of content and data users create, update, query, and relate to other items.

## Junction Collection

A junction collection is an intermediate collection used to connect records across other collections. It is commonly used to model many-to-many relationships.

## Layout

A layout controls how items in a collection are browsed in the app. Examples include table, cards, calendar, and map views.

## Module

A module is a top-level area of the app. The built-in modules are Content, User directory, File library, Insights, Help, and Settings. Custom modules can add entirely new app surfaces.

## Multitenancy

Multitenancy means one system serves multiple tenants, such as customers or internal groups.

In CairnCMS, this is usually achieved in one of two ways:

- separate instances per tenant
- one instance with roles, filters, and permissions that scope access per tenant

## Panel

A panel is one visualization or content block inside a dashboard. Panels can show metrics, charts, tables, or rich text.

## Permission

A permission defines what a role can do. Permissions can control create, read, update, and delete access at the collection level, field level, and rule level.

## Preset

A preset stores a saved view or default configuration for browsing a collection in the app. Presets can capture filters, sorting, layout choices, and other view state.

## Primary Key

A primary key is the field that uniquely identifies one item inside a collection. It is often named `id`.

Every collection needs a primary key so that individual items can be referenced consistently.

## Relationship

A relationship links records across collections. Common relationship types include one-to-many, many-to-one, many-to-many, and many-to-any.

## Revision

A revision is a stored historical version of an item after a change. Revisions support item-level history and are linked to the activity that produced them.

## Role

A role is a named set of permissions assigned to users. Roles determine which collections, fields, actions, and parts of the app a user can access.

CairnCMS includes a Public role for unauthenticated access and typically starts with an administrator role for initial setup.

## Singleton

A singleton is a collection intended to hold exactly one item. It is useful for data such as site settings, contact details, or other one-off configuration records.

## Storage Adapter

A storage adapter is the backend CairnCMS uses for file contents. Supported options include local disk, S3-compatible object storage, Google Cloud Storage, Azure Blob Storage, and Cloudinary.

## Translation

In CairnCMS, translation can refer to two different things:

- translating the app interface itself into different human languages
- storing multilingual content in your own schema

These are related but separate concerns.

## Type

A type describes how a field value is stored and interpreted at the database level. CairnCMS exposes the following storage types:

- text: string, text
- numeric: integer, big integer, float, decimal
- temporal: timestamp, datetime, date, time
- other scalar: boolean, JSON, CSV, UUID, hash
- geometric: geometry, point, linestring, polygon, multipoint, multilinestring, multipolygon

Alias is used internally for fields that do not have a database column, such as one-to-many relations and presentation fields.

The exact database representation may vary by vendor, but CairnCMS exposes a consistent model on top of those differences.

## User

A user is an account that can authenticate against a CairnCMS instance. Each user is assigned a role, and that role determines what the user can see and do.
