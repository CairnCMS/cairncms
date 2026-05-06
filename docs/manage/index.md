---
title: Manage
description: Operating a CairnCMS deployment. Configuration, deployment, security hardening, backups, upgrades, and the schema-as-code and config-as-code workflows for moving state between environments.
---

This section is for running CairnCMS in production. The pages here cover the operator-facing surfaces: configuring the environment, deploying the platform, hardening it for production traffic, backing it up, upgrading between versions, and moving schema and access-control state between deployments.

For first-time installation and local exploration, see [Quickstart](/docs/getting-started/quickstart/). For developer-facing customization, see [Develop](/docs/develop/). For the underlying API reference, see [API reference](/docs/api/).

## Pages in this section

- **[Configuration](/docs/manage/configuration/)** — the environment variables that govern every subsystem (auth, storage, cache, mail, rate limiting, logging).
- **[Deployment](/docs/manage/deployment/)** — running the official Docker image alongside your database and supporting services. Single-host Compose, Kubernetes, and the bootstrap-then-start lifecycle.
- **[Security hardening](/docs/manage/security-hardening/)** — production-safety configuration: TLS, secrets, the Public role, admin access, rate limiting, CORS, and the email-link allow lists.
- **[Backups](/docs/manage/backups/)** — what state needs backing up, per-vendor dump and restore commands, and the restore drill.
- **[Upgrades](/docs/manage/upgrades/)** — the version model, the standard upgrade procedure, multi-instance considerations, and rollback.
- **[Schema as code](/docs/manage/schema-as-code/)** — capturing the data model to a versioned file and applying it across environments.
- **[Migration between instances](/docs/manage/migration-between-instances/)** — moving a deployment from one home to another, including cross-vendor and cross-version migrations.
- **[Config as code](/docs/manage/config-as-code/)** — the same diff/apply pattern for roles and permissions.

## Where to go after this section

- [API reference](/docs/api/) — the endpoints behind the operator surfaces, including the `/schema/*` and `/config/*` endpoints used by schema-as-code and config-as-code.
- [Develop](/docs/develop/) — the customization surfaces that the production instance hosts.
- [Contributing](/docs/contributing/) — running CairnCMS from source rather than from the published image.
