---
title: Architecture
description: How CairnCMS is structured and how requests flow through the system.
---

CairnCMS is an application layer on top of a SQL database and a file storage backend. It adds an admin app, generated APIs, permissions, file management, dashboards, automation, and extension points without taking ownership of your application data.

This page describes what each layer does and how a typical request moves through them.

## What is the high-level shape?

The platform breaks down into five conceptual layers. At the bottom is your database and file storage, which CairnCMS treats as the source of truth. Above that, schema inspection reads the database structure and produces an internal metadata model that the rest of the platform works against. The data engine and service layer use that model to handle reads, writes, queries, and side effects. Access control and authentication enforce who can do what before any data leaves the system. At the top sit the surfaces that users and other systems interact with: the admin app, REST and GraphQL APIs, the CLI, and the JavaScript SDK.

The same collection can be used in several ways at once. Editors manage records in the admin app while clients query the same data through REST or GraphQL, permissions constrain what each of them sees, and flows and webhooks react to changes in the same collections. The internal model is what keeps all of these views consistent.

## The database is the source of truth

CairnCMS is built around standard SQL tables. Your application data stays in the database you choose; CairnCMS reads the schema, works with it, and adds the platform features around it.

You can start from an existing database instead of migrating into a proprietary content store, or you can build a new schema from inside the app and let CairnCMS create the tables for you. Either way, you can still inspect, query, back up, and migrate the database directly. Your data is not locked behind a vendor-specific storage model.

CairnCMS keeps its own metadata in a set of system tables: users, roles, permissions, dashboards, flows, and other platform configuration. Those tables are separate from your domain data; your application data lives in standard SQL tables independent of CairnCMS.

## Schema inspection and the internal model

When CairnCMS connects to a database, it reads the schema and builds an internal model of the collections, fields, relationships, and vendor-specific data types. This abstraction layer is what lets the platform work across multiple SQL vendors without exposing every database-specific difference to the rest of the codebase.

The internal model is also what makes the admin app and generated APIs possible. If a collection exists in the model, CairnCMS can render it in the app, expose it through the API, apply permissions to it, use it in flows and webhooks, and include it in schema snapshots.

## The data engine

Above schema inspection sits the layer that handles the actual data work. It is responsible for CRUD operations against collections and items; filtering, sorting, pagination, and relational traversal; file processing and image transformations; schema snapshot, diff, and apply workflows; config snapshot and apply workflows; and triggering flows and webhooks when data changes.

Both REST and GraphQL rely on this layer. The two APIs are different interfaces over the same underlying services, not two separate data paths.

## Access control and authentication

CairnCMS applies permissions before data leaves the system. Authentication is handled through login flows and token-based access. Beyond authentication, the platform supports a Public role for unauthenticated access and any number of custom roles with collection-level, field-level, and rule-based permissions. App and admin access flags control who can use the admin interface at all, and optional hardening like IP allowlists and required two-factor authentication is available where stricter controls are needed.

The result is that the same collection can appear differently to different users. One role may have full write access; another may be read-only; another may not see the collection at all.

## What are the interfaces on top?

Most people interact with CairnCMS through one of three broad surfaces.

### The admin app

The admin app is the browser-based interface for shaping the data model, managing records and files, configuring roles and permissions, building dashboards, creating flows, and operating the system day to day. It is not a separate source of truth. It is a client of the same platform services that power the APIs.

### REST and GraphQL APIs

CairnCMS generates REST and GraphQL endpoints from the current schema and permission model. Use these when you need to power a website or application frontend, integrate with another service, run scripts or backend jobs against CairnCMS data, or automate provisioning and deployment workflows.

### CLI and SDK

The CLI handles operational work against a running instance, including schema and configuration snapshot and apply workflows, scripted integrations, and instance-level operations from a shell or container environment. The JavaScript SDK provides typed client access for applications that need to call the API from code.

## Where do files fit?

Files are part of the same platform model, but the bytes themselves live wherever you choose. CairnCMS tracks file metadata in the database (record IDs, names, types, dimensions, folder placement) while storing the file contents on a configured backend such as local disk, S3-compatible object storage, Google Cloud Storage, Azure Blob Storage, or Cloudinary. That split is why the file library can present one consistent workflow even when the underlying storage provider changes.

## Where does headless delivery fit?

When CairnCMS is used for headless content delivery, the architecture is straightforward. CairnCMS manages the schema, content, files, and permissions; your frontend or other client fetches content through REST or GraphQL; rendering happens wherever you choose. That client might be a server-rendered web app, a statically generated site, a mobile app, an internal dashboard, or another backend service. CairnCMS does not prescribe the presentation layer. It provides the content and data layer those clients consume.

## Extensibility

CairnCMS is designed to be extended in both the app and the API. Extension points include interfaces, displays, layouts, modules, panels, hooks, endpoints, operations, bundles, themes, migrations, and email templates. That breadth matters architecturally because not every feature belongs in core. A smaller core plus clear extension points is how the platform stays adaptable without forcing every deployment into the same shape.

## A typical request flow

For a normal API request, the path looks like this:

1. A client sends a REST or GraphQL request.
2. CairnCMS authenticates the request if needed.
3. Permissions are resolved for the current user or role.
4. The request is routed through the data engine.
5. The query is executed against the database.
6. The response is filtered to match the permission model.
7. The result is returned to the client.
8. If the request changed data, activity logs, revisions, flows, and webhooks may also be triggered.

The admin app follows the same general path. It is not bypassing the platform; it is using it.

## Why does this architecture matter?

This is the core value CairnCMS offers. You keep your own database, your own storage choices, your own deployment model, and direct access to the underlying data. You gain an admin app, generated APIs, roles and permissions, automation, file management, dashboards, and extension points around all of it. That is what lets CairnCMS work as both a CMS and a broader SQL-backed admin platform.

## Where to go next

If you want to see the architecture in practice:

- [Quickstart](/docs/getting-started/quickstart/)
- [App overview](/docs/getting-started/app-overview/)
- [Glossary](/docs/getting-started/glossary/)
