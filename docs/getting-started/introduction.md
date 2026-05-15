---
title: Introduction
description: What CairnCMS is, who it is for, and when it fits.
sidebar:
  order: 1
---

CairnCMS is open content and data infrastructure for self-hosted teams. Use it to model data, manage content, expose APIs, and automate workflows from one workspace built on SQL tables you control. Your SQL schema defines the model; CairnCMS adds the governed workspace around it (a no-code admin app, generated REST and GraphQL APIs, role-based access control, file management, dashboards, and automation) for managing the structured content and operational data your systems depend on.

## What is CairnCMS?

CairnCMS sits between your team and your database. You can model a new schema through the admin app, or connect to an existing SQL schema and work from there. Once a collection is set up, the same data is available through a browser-based interface for records and files, REST and GraphQL APIs for external clients, flows for automation, and a role-based permission system that gates all of it.

The platform is not built around a fixed content model. Your SQL schema defines what an item is on a per-collection basis; CairnCMS provides the workspace, APIs, permissions, and workflows around whatever shape you give it. That makes it suitable for content that ships to a public-facing site, operational data that feeds an internal tool, structured records that drive a SaaS product, or any combination of those in one workspace.

## Who is CairnCMS for?

CairnCMS is useful when several kinds of users need to work with the same system.

### Developers

Developers get a self-hosted admin and API layer on top of SQL, with REST and GraphQL endpoints generated from the schema. A JavaScript SDK provides typed client access, and an extension system lets you customize anything that does not fit out of the box. The underlying database stays directly accessible when you need it, and schema and configuration workflows fit version-controlled development.

### Operators and maintainers

Operators get a deployable self-hosted stack configured through environment variables and Docker-friendly workflows. Storage, email, authentication, and security settings are explicit and operator-controlled. The platform can be inspected, configured, and operated without depending on a vendor service in the middle.

### Editors and internal teams

Editors and other non-developer users get a browser-based workspace for managing records and files. Collections and actions are scoped by role, so people only see what they should. Comments, revision history, and share links support collaboration, and dashboards and simple automation are available without writing code.

## When does CairnCMS fit?

CairnCMS is a good fit when you want a SQL-backed platform with an admin app and APIs, but do not want to give up control of the underlying data model.

Common fits include headless content delivery to websites and apps, internal tools and operational back offices, SaaS products that need a role-aware admin surface, data-heavy applications that benefit from generated APIs and workflows, and teams migrating from spreadsheets or ad hoc admin panels to a structured system. It also fits when you need the platform features around a database, not just the database itself.

## Databases and storage

CairnCMS supports PostgreSQL, MySQL, MariaDB, and SQLite. Files can be stored on local disk or external backends such as S3-compatible object storage, Google Cloud Storage, Azure Blob Storage, and Cloudinary, depending on your deployment needs.

## Open source and control

CairnCMS was created to preserve a database-first platform under a fully open-source GPLv3 license. The practical effect is that the codebase is FLOSS-licensed, your database stays yours to inspect, query, back up, and migrate, and the platform can be extended or operated without depending on a hosted control plane.

## Where to go next

If you want to try CairnCMS locally, start with the [Quickstart](/docs/getting-started/quickstart/).

After that, the most useful next pages are usually:

- [Architecture](/docs/getting-started/architecture/)
- [App overview](/docs/getting-started/app-overview/)
- [Glossary](/docs/getting-started/glossary/)
