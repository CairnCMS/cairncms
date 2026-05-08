---
title: API reference
description: REST and GraphQL reference for CairnCMS. Endpoint shapes, authentication, query DSL, the SDK, and the system collections that hold platform-managed state.
sidebar:
  label: Overview
  order: 0
---

This section is the endpoint reference for CairnCMS. Every collection, system or user-defined, has REST and GraphQL surfaces generated from the running schema, plus a small set of operator-side endpoints (`/schema/*`, `/config/*`, `/server/*`, `/utils/*`) that are not collection-shaped. The pages here cover the conventions, the per-collection specifics, and the SDK that wraps them.

For running a CairnCMS deployment, see [Manage](/docs/manage/). For building applications and extensions, see [Develop](/docs/develop/).

## Pages in this section

- **[Introduction](/docs/api/introduction/)** — the API's overall shape: REST and GraphQL roots, the response envelope, the system-versus-user split, and the global error codes.
- **[Authentication](/docs/api/authentication/)** — token types, login and refresh flows, SSO providers, two-factor authentication, and how to attach credentials to requests.
- **[Items](/docs/api/items/)** — read, create, update, and delete items in user-defined collections, including batch and query-based variants and relational writes.
- **[Files](/docs/api/files/)** — upload, manage, and serve assets through `/files` (metadata) and `/assets` (bytes, with on-the-fly image transforms).
- **[Filters and queries](/docs/api/filters-and-queries/)** — the query DSL shared by REST and GraphQL: field selection, filtering, sorting, pagination, aggregation, deep queries.
- **[GraphQL](/docs/api/graphql/)** — the two GraphQL endpoints, the request format, schema introspection, and the surfaces that are intentionally REST-only.
- **[SDK](/docs/api/sdk/)** — `@cairncms/sdk`, the official JavaScript client. Composition pattern, REST and GraphQL composables, authentication, and schema-typed queries.
- **[System collections](/docs/api/system-collections/)** — the platform-owned `directus_*` tables and the operator endpoints that pair with them. Split into seven topical pages plus a hub.

## Where to go after this section

- [Manage](/docs/manage/) — the operator-facing reference for the surfaces these endpoints wrap.
- [Develop](/docs/develop/) — building applications and extensions on top of these endpoints.
- [Filters and queries](/docs/api/filters-and-queries/) and [Items](/docs/api/items/) — the two pages that anchor most day-to-day API usage.
