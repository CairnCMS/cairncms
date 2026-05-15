---
title: Automation
description: REST and GraphQL surfaces for flows and operations. The endpoints, record shapes, and the bespoke `/flows/trigger/<id>` route that turns a flow into an HTTP-callable handler.
sidebar:
  order: 3
---

CairnCMS's automation surface comes in two system collections: **flows** define automated processes and **operations** are the steps inside a flow. Flows handle both inbound HTTP requests (Webhook trigger) and outbound HTTP calls (Webhook / Request URL operation), so the standalone webhook collection from earlier Directus versions is not present. The data model and the operator UX are documented in [Automate](/docs/guides/automate/); this page covers the API surface.

Each collection has the standard CRUD shape documented in [Items](/docs/api/items/), and `directus_flows` adds one bespoke endpoint that exposes a flow as an HTTP-callable handler.

## Flows (`/flows`)

A flow defines a chain of operations triggered by an event. The platform supports five trigger types:

- **Event hook** — fires on item create / update / delete events.
- **Schedule** — fires on a cron expression.
- **Webhook** — fires on an inbound HTTP request to `/flows/trigger/<flow-id>`.
- **Manual** — fires from the admin app (a button on a collection or item view), also reachable via `/flows/trigger/<flow-id>`.
- **Operation** — fires when another flow's operation calls into this flow.

The first two run on internal events; the next two are HTTP-callable; operation-triggered flows are reached only through other flows. The endpoint shape is the same regardless of trigger type for create/read/update/delete, but only flows configured with a webhook or manual trigger respond to `/flows/trigger/<flow-id>`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/flows` | List flows. |
| `SEARCH` | `/flows` | Read flows with the request body. |
| `GET` | `/flows/<id>` | Read a single flow. |
| `POST` | `/flows` | Create one or many flows. |
| `PATCH` | `/flows` | Update many flows. |
| `PATCH` | `/flows/<id>` | Update a single flow. |
| `DELETE` | `/flows` | Delete many flows. |
| `DELETE` | `/flows/<id>` | Delete a single flow. |
| `GET` | `/flows/trigger/<id>` | Trigger a webhook flow configured for `GET`. |
| `POST` | `/flows/trigger/<id>` | Trigger a webhook flow configured for `POST` or any manual flow. |

### Flow record fields

- **`id`** (UUID) — primary key.
- **`name`**, **`icon`**, **`color`**, **`description`** — display metadata.
- **`status`** — `active` or `inactive`. Inactive flows ignore their triggers and the trigger endpoint returns `403`.
- **`trigger`** — one of `event`, `schedule`, `webhook`, `manual`, `operation`.
- **`accountability`** — controls how the flow run is recorded. Operations always execute under whatever accountability the trigger passes through (the requesting user for webhook and manual flows, the user whose action triggered the event for event hooks, no accountability for schedule and operation triggers); this field does not change that. The values are: `all` writes an activity row for the run and a revision row containing the full step-by-step execution trace, `activity` writes the activity row without the revision, and `null` skips both. The naming is historical and a little misleading; treat it as the run-logging policy, not as a permission switch.
- **`options`** — per-trigger configuration (the cron expression for schedule, the HTTP method and async flag for webhook, the allowed collections for manual, and so on).
- **`operation`** — UUID of the first operation. Subsequent operations chain through `resolve` and `reject` references on each operation row.
- **`operations`** — alias field listing all operations belonging to this flow.
- **`date_created`**, **`user_created`** — accountability.

### `/flows/trigger/<id>`

Two flow trigger types translate to HTTP routes: webhook and manual.

**Webhook flows** are configured with a `method` option (`GET` or `POST`); only requests using that method against the matching flow ID resolve. The handler receives the request's `path`, `query`, `body`, `method`, and `headers` as the operation chain's input data.

```http
POST /flows/trigger/<flow-id>
Content-Type: application/json

{ "anything": "the flow operations expect" }
```

The response body is the result of the last operation in the chain unless the flow's `options.return` is set to a different operation key. If the flow's `options.async` is `true`, the request returns immediately and the operations run in the background; otherwise the request waits for the chain to complete.

**Manual flows** also resolve through `/flows/trigger/<flow-id>` but require POST and a body that names the target collection:

```http
POST /flows/trigger/<flow-id>
Content-Type: application/json

{
  "collection": "articles",
  "keys": ["<id-1>", "<id-2>"]
}
```

`collection` is required. `keys` is conventional for collection-page manual flows that operate on selected items, but it is not strictly required: a manual flow with `requireSelection: false` (configured through the admin app) can run against a collection without specific item IDs, and the body in that case is just `{ "collection": "articles" }` plus any operator-supplied confirmation values.

The flow's `options.collections` lists which collections it can run against. Requests targeting a collection outside that list return `403 FORBIDDEN`. The flow operations receive the full request body plus path, query, method, and headers as input data.

A request to `/flows/trigger/<id>` for a flow whose trigger type is anything other than `webhook` or `manual` (or for a flow that does not exist) returns `403 FORBIDDEN`. The response code is intentional: distinguishing "wrong trigger type" from "no such flow" would leak which flow IDs exist.

## Operations (`/operations`)

An operation is one step in a flow. Each operation has a type (the operation extension that runs it), a key (used to reference its output downstream), and `resolve` / `reject` pointers to the next operations on success and failure.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/operations` | List operations. |
| `SEARCH` | `/operations` | Read operations with the request body. |
| `GET` | `/operations/<id>` | Read a single operation. |
| `POST` | `/operations` | Create one or many operations. |
| `PATCH` | `/operations` | Update many operations. |
| `PATCH` | `/operations/<id>` | Update a single operation. |
| `DELETE` | `/operations` | Delete many operations. |
| `DELETE` | `/operations/<id>` | Delete a single operation. |

There is no HTTP endpoint to invoke an operation directly. Operations run only as part of a flow chain; to invoke an operation from outside, build a flow with a webhook or manual trigger that has the operation as its first step.

### Operation record fields

- **`id`** (UUID) — primary key.
- **`name`** — display name.
- **`key`** — short identifier used to reference this operation's output downstream. References take the form `{{ <key> }}` in subsequent operation `options` payloads.
- **`type`** — the operation type (the operation extension that runs the step). Built-in types include `condition`, `exec`, `item-create`, `item-read`, `item-update`, `item-delete`, `mail`, `notification`, `request`, `transform`, `trigger`, `log`, and `sleep`. Custom operation extensions add to this list.
- **`position_x`**, **`position_y`** — coordinates in the flow editor's grid.
- **`options`** — per-type configuration. Shape varies by `type`.
- **`resolve`** — UUID of the operation to run next on success. Null at the end of a chain.
- **`reject`** — UUID of the operation to run on failure. Null skips error handling, in which case the flow halts.
- **`flow`** — UUID of the flow this operation belongs to.
- **`date_created`**, **`user_created`** — accountability.

The platform stores operations independently of their parent flow. The flow's chain is built at runtime by traversing from `flow.operation` through `resolve`/`reject` references, so operations that are not reachable from the entry point still exist in the database but never run, and broken `resolve`/`reject` references only surface when the chain is constructed. There is no API-side enforcement that the chain is well-formed. Editing operations directly through `/operations` rather than the admin app is supported for migration and tooling, but the admin app is where the chain shape is most easily kept consistent.

## Permission semantics

Both collections are admin-only by default. Granting non-admin write access to either is a privilege escalation surface: a role that can edit flows or operations can configure them to bypass accountability with `accountability: null`. Treat any non-admin grant as a deliberate decision.

Read access is sometimes granted to non-admins for inspection and reporting, but the operation `options` payloads can contain credentials passed through to external services; consider field-level filtering when granting any read access.

## GraphQL

Both collections are exposed on `/graphql/system` with the standard generated CRUD shape (`flows`, `operations` for queries; `create_flows_item`, `update_operations_item`, and so on for mutations). Filter, sort, and pagination arguments work the same way as on user collections; see [Filters and queries / GraphQL](/docs/api/filters-and-queries/#graphql).

The bespoke `/flows/trigger/<id>` endpoint is REST-only. There is no GraphQL equivalent because the request shape varies per flow (the body becomes the operations' input data) and GraphQL's typed interface does not fit that shape.

## Where to go next

- [Automate](/docs/guides/automate/) — operator-facing reference for designing flows, the trigger types, and the operation catalog.
- [Operations](/docs/develop/extensions/operations/) — building custom operations as extensions.
- [Hooks](/docs/develop/extensions/hooks/) — the lower-level event surface that flows are built on top of.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL for filtering flow and operation lists.
