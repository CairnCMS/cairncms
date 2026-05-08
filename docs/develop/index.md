---
title: Develop
description: Developer-facing customization for CairnCMS. Building applications against the API, extending the platform with the nine extension types, writing custom migrations, and authoring email templates.
sidebar:
  label: Overview
  order: 0
---

This section covers building things on or alongside CairnCMS. Two distinct activities live here: writing application code that consumes the platform's API (a frontend, a service-to-service integration, a CLI tool) and extending the platform itself (custom interfaces, hooks, endpoints, operations, and so on).

For administering the data model and content through the admin app, see [Guides](/docs/guides/). For platform operations and deployment, see [Manage](/docs/manage/). For the underlying endpoint reference, see [API reference](/docs/api/).

## Pages in this section

- **[Clients](/docs/develop/clients/)** — durable patterns for building applications against CairnCMS: authentication, querying items, mutations, file upload, the SDK versus raw HTTP, and public access.
- **[Extensions](/docs/develop/extensions/)** — the nine extension types (interface, display, layout, module, panel, hook, endpoint, operation, bundle), the SDK and scaffolder, and the build, install, and publish workflow.
- **[Custom migrations](/docs/develop/custom-migrations/)** — adding migration files to `EXTENSIONS_PATH/migrations` so they run alongside platform migrations.
- **[Email templates](/docs/develop/email-templates/)** — overriding the built-in email templates and adding new ones for the Send Email flow operation.

## Where to go after this section

- [API reference](/docs/api/) — endpoint reference for what the SDK and clients section wrap.
- [Manage](/docs/manage/) — the operator side of the platform that hosts the extensions you build.
- [Guides](/docs/guides/) — operator-facing reference for the admin-app surfaces extensions plug into.
