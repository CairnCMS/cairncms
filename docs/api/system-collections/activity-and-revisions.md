---
title: Activity and revisions
description: REST and GraphQL surfaces for the activity log (the per-action audit trail with comment management) and the revision history (per-row state at every change, with a revert endpoint).
sidebar:
  order: 6
---

Two system collections record what happened in a CairnCMS deployment. **Activity** is the per-action audit trail: who did what to which item, when, from which IP, with what comment. **Revisions** is the per-row history: the full state of each item after every change, suitable for reverting. Activity rows are not generally editable (the only write surface is the comment management endpoints), and revisions are read-only.

## Activity (`/activity`)

A row in `directus_activity` records one event in the platform: a create, update, delete, login, comment, or flow run. The platform writes activity rows automatically as those actions happen; the only operator-facing writes go through the comment-management endpoints.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/activity` | List activity rows. |
| `SEARCH` | `/activity` | Read activity rows with the request body. |
| `GET` | `/activity/<id>` | Read a single activity row. |
| `POST` | `/activity/comment` | Create a comment activity row attached to a specific item. |
| `PATCH` | `/activity/comment/<id>` | Update the comment text on an existing comment row. |
| `DELETE` | `/activity/comment/<id>` | Delete a comment row. |

The collection is intentionally write-restricted. There is no general `POST /activity`, no `PATCH /activity/<id>`, and no `DELETE /activity/<id>`. Operator-facing writes are restricted to the `/comment` paths so the audit trail cannot be edited or deleted to hide actions. Comments are the exception because they are operator-authored content rather than platform-recorded facts.

### Activity record fields

- **`id`** (auto-incrementing integer) — primary key.
- **`action`** — one of `create`, `update`, `delete`, `login`, `comment`, `run`. The platform writes the first four automatically when the corresponding action happens; `comment` rows come from the `/activity/comment` endpoint; `run` rows come from flow executions configured with `accountability` set to anything other than `null`.
- **`collection`** — the collection the action targeted.
- **`item`** — the primary key of the affected item, as a string. For collections with integer keys, the integer is stringified.
- **`timestamp`** — auto-populated on insert.
- **`user`** — the user who performed the action, or null for unauthenticated requests (Public role) and platform-internal events.
- **`ip`**, **`user_agent`**, **`origin`** — request metadata captured at the time of the action. Useful for forensic review.
- **`comment`** — the comment body. Set only on rows whose `action` is `comment`; null otherwise.
- **`revisions`** — alias field listing the `directus_revisions` rows that this activity row produced. One activity row can have many revisions when a single transaction changes multiple items.

### `POST /activity/comment`

Creates a comment row attached to a specific item. The platform fills in the actor's `user`, `ip`, `user_agent`, and `origin` automatically.

```http
POST /activity/comment
Content-Type: application/json

{
  "collection": "articles",
  "item": "42",
  "comment": "Reviewed and approved for publication."
}
```

Body fields:

- **`collection`** (required) — the target collection.
- **`item`** (required) — the primary key of the target item. Accepts string or number.
- **`comment`** (required) — the comment body.

The response is the created activity row, re-read through any `fields` and `deep` query parameters set on the request.

### `PATCH /activity/comment/<id>` and `DELETE /activity/comment/<id>`

Update or delete an existing comment row. Only the `comment` field is updatable; the rest of the activity row is fixed once the comment is created.

`DELETE /activity/comment/<id>` checks that the target row's `action` is `comment` and returns `403` for any other activity row. `PATCH /activity/comment/<id>` does not perform that check at the controller level: an admin caller could in principle update the `comment` field on a non-comment activity row through this route. The route is named for comments and intended for that case; treat the lack of a controller-level guard as an implementation detail rather than supported behavior.

By default, only the comment's author and admins can edit or delete a given comment.

## Revisions (`/revisions`)

A row in `directus_revisions` records one change to one item. The platform writes revision rows automatically when collections have `accountability` set to `all` (the default for new collections), but only for create and update actions. Deletes write an activity row but no revision row, since the row no longer exists to revert to. Revisions are append-only and platform-managed; the `/revisions` API is read-only.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/revisions` | List revision rows. |
| `SEARCH` | `/revisions` | Read revisions with the request body. |
| `GET` | `/revisions/<id>` | Read a single revision row. |

There is no create, update, or delete endpoint on `/revisions`. To revert an item to a specific revision, use `POST /utils/revert/<revision-id>` from the [Platform and utilities](/docs/api/system-collections/platform-and-utilities/) page.

### Revision record fields

- **`id`** (auto-incrementing integer) — primary key.
- **`activity`** — reference to the `directus_activity` row that produced this revision. The activity row holds the actor and timestamp; the revision row holds the data.
- **`collection`** — the collection the revision belongs to.
- **`item`** — the primary key of the affected item.
- **`data`** — for update revisions, the complete state of the item after the change, as a JSON object including every field. For create revisions, the same prepared delta as `delta` (the platform does not snapshot the full post-create row state, since the create payload effectively is the full state).
- **`delta`** — only the fields that changed in this revision, as a JSON object. Useful for showing diffs in operator tooling without materializing the full row state.
- **`parent`** — reference to the previous revision for the same item, or null for the first revision. Forms a linked list of revisions per item.

The split between `data` and `delta` is what makes revert practical for updates: applying `data` overwrites the entire row, while applying `delta` is a targeted patch. Reverting to a create revision is functionally a no-op against the current row, since `data` and `delta` describe the same payload.

### Reverting

```http
POST /utils/revert/<revision-id>
```

Reverts the affected item to the state captured in the named revision. The revert produces a new activity row and a new revision row recording the revert itself, so the audit trail stays consistent. The operation is admin-only by default. See [Platform and utilities](/docs/api/system-collections/platform-and-utilities/) for the full reference.

### Why some collections do not have revisions

Revisions are written only when the affected collection's `accountability` setting is `all`. Collections set to `activity` write activity rows but no revision payload, and collections set to `null` write neither. The setting is on each collection's `meta` record (see [Schema and modeling](/docs/api/system-collections/schema-and-modeling/)). System collections that are not user-revertible (like `directus_sessions` or `directus_notifications`) typically have `accountability: null` to avoid filling the revisions table with platform housekeeping.

## Permission semantics

The platform projects a narrow set of defaults for app-access roles:

- **`directus_activity` read** — projected with a `user: { _eq: $CURRENT_USER }` filter, so app-access users see only activity rows where they were the actor. Operators who want users to see a broader activity feed (their team's actions, all actions on a specific collection) need an explicit permission row that overrides this default.
- **`directus_activity` create** — projected with a validation rule requiring `comment: { _nnull: true }`, so app-access users can only create comment rows through `/activity/comment` and not arbitrary activity entries.

There is no projected default read permission on `directus_revisions`. Operators who want app-access users to see the per-item history view need to grant `directus_revisions` read explicitly. A `collection` filter scoped to the collections the user can read is a reasonable starting point.

For non-app-access roles (Public, custom-restricted roles), all activity and revision permissions are off by default. Operators who want to expose an activity feed to a public audience need explicit grants with appropriate filters; revisions almost never make sense to expose publicly.

## GraphQL

Activity and revisions have non-standard GraphQL surfaces:

- **`directus_activity`** is exposed as read-only on `/graphql/system` (the standard generated mutations are suppressed) but adds bespoke comment mutations: `create_comment`, `update_comment`, and `delete_comment`. These cover the same operations as the `POST /activity/comment`, `PATCH /activity/comment/<id>`, and `DELETE /activity/comment/<id>` REST routes. They are not strictly identical: the REST `DELETE /activity/comment/<id>` route guards against deleting non-comment activity rows, while the GraphQL `delete_comment` mutation calls the underlying delete directly without that guard. For comment management through GraphQL, pass IDs that you know correspond to comment rows.
- **`directus_revisions`** is exposed as fully read-only. The standard `revisions` and `revisions_by_id` queries work; no mutations are generated.

The `POST /utils/revert/<revision-id>` endpoint is REST-only.

## Where to go next

- [Platform and utilities](/docs/api/system-collections/platform-and-utilities/) — covers `POST /utils/revert/<revision-id>` and other operator-facing utility endpoints.
- [Schema and modeling](/docs/api/system-collections/schema-and-modeling/) — the `accountability` setting on `directus_collections.meta` controls whether revisions are written for each collection.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL for filtering activity and revision feeds.
- [Activity log](/docs/guides/content/activity-log/) — operator-side reference for the admin app's activity view.
