---
title: Organization
description: REST and GraphQL surfaces for folders (the file library's tree structure) and presets (per-user layout configurations and collection bookmarks).
---

Two system collections handle non-content organizational state in CairnCMS: **folders** structure the file library into a tree, and **presets** store the per-user, per-role, or global layout configurations that the admin app uses for collection views and saved bookmarks. Both follow the standard CRUD shape with no bespoke endpoints.

## Folders (`/folders`)

A folder organizes files in the file library. The collection is a self-referencing tree: each row optionally points at a parent folder, and `directus_files.folder` references a folder. Files in CairnCMS are not strictly required to live in a folder; folders are an organizational convenience for the admin app, not a structural requirement.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/folders` | List folders. |
| `SEARCH` | `/folders` | Read folders with the request body. |
| `GET` | `/folders/<id>` | Read a single folder. |
| `POST` | `/folders` | Create one or many folders. |
| `PATCH` | `/folders` | Update many folders (three body shapes). |
| `PATCH` | `/folders/<id>` | Update a single folder. |
| `DELETE` | `/folders` | Delete many folders. |
| `DELETE` | `/folders/<id>` | Delete a single folder. |

### Folder record fields

- **`id`** (UUID) — primary key.
- **`parent`** — UUID of the parent folder, or null for top-level folders. The relation is self-referencing on `directus_folders`, so a folder's parent must already exist when the row is created.
- **`name`** — display name. Folders within the same parent should have unique names by convention; the platform does not enforce it at the schema level.

The folder tree is built client-side by traversing the `parent` references. Cycles are not validated; do not point a folder at one of its descendants.

Deleting a folder does not cascade to child folders or to the files inside it. `directus_files.folder` is set to null on file rows that referenced the deleted folder, and child folders become top-level (their `parent` becomes null). To delete a folder and its contents, batch-delete the children explicitly first.

## Presets (`/presets`)

A preset stores a layout configuration for a collection: which fields are visible, the active filter, the sort order, the active layout type, and the search term. Presets serve two related purposes:

- **View defaults** — the layout state a user sees when they open a collection. The admin app picks the most-specific preset that applies (user, then role, then global) and uses it as the starting point.
- **Bookmarks** — saved layout configurations a user can switch between. A row with a non-null `bookmark` value shows up in the bookmarks selector.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/presets` | List presets. |
| `SEARCH` | `/presets` | Read presets with the request body. |
| `GET` | `/presets/<id>` | Read a single preset. |
| `POST` | `/presets` | Create one or many presets. |
| `PATCH` | `/presets` | Update many presets (three body shapes). |
| `PATCH` | `/presets/<id>` | Update a single preset. |
| `DELETE` | `/presets` | Delete many presets. |
| `DELETE` | `/presets/<id>` | Delete a single preset. |

### Preset record fields

- **`id`** (auto-incrementing integer) — primary key.
- **`bookmark`** (string) — display name when the preset is a saved bookmark. `null` for view-default presets that should not appear in the bookmarks selector.
- **`icon`**, **`color`** — bookmark display metadata.
- **`collection`** — the collection this preset applies to.
- **`layout`** — the active layout (`tabular`, `cards`, `calendar`, `map`, or any custom layout-extension key).
- **`layout_query`** — JSON object holding the layout-specific query state (sort, fields, depth, and so on).
- **`layout_options`** — JSON object holding layout-specific UI options (column widths for tabular, card size for cards, and so on).
- **`filter`** — JSON filter expression in the standard query DSL.
- **`search`** — full-text search term.
- **`refresh_interval`** — auto-refresh interval in seconds, or null for no auto-refresh.
- **`user`** — UUID of the user the preset applies to. Null means the preset applies regardless of user.
- **`role`** — UUID of the role the preset applies to. Null means the preset applies regardless of role.

The combination of `user` and `role` determines a preset's scope:

- **User-specific** (`user` set, `role` set or null) — applies only to that user. Bookmarks the user creates land here by default.
- **Role-specific** (`user` null, `role` set) — applies to every user in that role.
- **Global** (`user` null, `role` null) — applies to every user. Operators use this for default views that should apply across the organization.

Resolution is most-specific-wins: a user-specific preset overrides a role-specific one, which overrides a global one for the same collection. The resolution happens client-side in the admin app, not on the server. The `/presets` API returns whatever rows match the request's filter; the consumer is responsible for picking the right row when more than one applies. Custom clients that surface user-facing layouts should follow the same rule (fetch user, role, and global rows, pick most-specific).

### Bookmarks vs view defaults

The `bookmark` field is the discriminator. Presets with a non-null `bookmark` show up in the admin app's bookmarks selector and represent named saved configurations. Presets with `bookmark: null` are view defaults: the platform applies them silently when a user opens the collection.

A user can have many bookmarks for the same collection (one per saved view) but typically only one view default. Operators creating role or global view defaults should leave `bookmark: null` so the configuration applies as a default rather than appearing in users' bookmark lists.

## Permission semantics

Folders are open to app-access roles by default. The platform's app-access minimum permissions include create, read, update, and delete on `directus_folders` for any role with `app_access: true`, so app users can organize the file library without operators having to grant explicit permissions. Permissions on `directus_folders` follow the same model as any other system collection if you need to scope access more tightly than the default; the minimum permissions are projected at read time and do not appear as rows in `/permissions`.

Presets are scoped at the row level by `user` and `role`. The recommended permission shape for non-admin app-access roles:

- **Read** — allow when `user` matches `$CURRENT_USER` or `role` matches `$CURRENT_ROLE` or both are null. This lets the user see their own bookmarks plus any role-level or global view defaults.
- **Create / Update / Delete** — allow when `user` matches `$CURRENT_USER`. This lets the user manage their own bookmarks without being able to modify role-level or global presets.

Operators who want to create role-level or global presets need either admin access or a custom permission that allows writes with `user: null`. Treat that grant as a deliberate decision; a role with permission to write `user: null` presets can change defaults seen by every user in that role (or every user in the project, for global presets).

## GraphQL

Both collections are exposed on `/graphql/system` with the standard generated CRUD shape (`folders`, `folders_by_id`, `create_folders_item`, etc.; same for `presets`). The query DSL options work the same way as in REST; see [Filters and queries / GraphQL](/docs/api/filters-and-queries/#graphql).

## Where to go next

- [Files](/docs/api/files/) — the file collection that uses `directus_folders.id` to organize uploads.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL stored in preset `filter` and `layout_query` fields.
- [Filters](/docs/guides/content/filters/) — operator-side reference for designing filters that end up serialized into preset rows.
