---
title: CairnCMS documentation
description: Documentation for CairnCMS, open content and data infrastructure for self-hosted teams, built on standard SQL tables you control.
---

CairnCMS is open content and data infrastructure for self-hosted teams. Use it to model data, manage content, expose APIs, and automate workflows from one workspace built on SQL tables you control. Your SQL schema defines the model; CairnCMS adds a governed workspace around it with a REST and GraphQL API, an admin app, role-based permissions, file management, dashboards, and an extension system that covers everything from custom field interfaces to server-side hooks. The result is a single place to manage the structured content and operational data that websites, applications, dashboards, and internal tools depend on.

The docs are organized into six sections, each scoped to a particular kind of work:

- **[Getting started](/docs/getting-started/)** — orientation for first-time users. What CairnCMS is, how to spin one up, how the pieces fit together, and the vocabulary used throughout the rest of the docs.
- **[Guides](/docs/guides/)** — operator and content-author tasks in the admin app. Modeling data, managing users and permissions, creating content, configuring automation.
- **[Develop](/docs/develop/)** — building applications against the API and extending the platform with custom interfaces, hooks, endpoints, operations, and the rest of the nine extension types.
- **[Manage](/docs/manage/)** — running CairnCMS in production. Configuration, deployment, security hardening, backups, upgrades, and the schema-as-code and config-as-code workflows.
- **[API reference](/docs/api/)** — REST and GraphQL endpoint reference. Authentication, items, files, the query DSL, the SDK, and the system collections that hold platform-managed state.
- **[Contributing](/docs/contributing/)** — how to contribute code or documentation to CairnCMS itself: repository layout, local development setup, and the project's PR conventions.

## Where to start

- New to CairnCMS: [Introduction](/docs/getting-started/introduction/) followed by [Quickstart](/docs/getting-started/quickstart/).
- Already running an instance and shaping content: [Guides](/docs/guides/).
- Building an application against a CairnCMS instance: [Clients](/docs/develop/clients/) and the [API reference](/docs/api/).
- Operating a deployment: [Configuration](/docs/manage/configuration/) and [Deployment](/docs/manage/deployment/).
- Contributing to the project: [Contributing](/docs/contributing/).
