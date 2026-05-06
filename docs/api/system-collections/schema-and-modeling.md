---
title: Schema and modeling
description: REST and GraphQL surfaces for collections, fields, and relations, plus the `/schema/*` endpoints that snapshot, diff, and apply the schema between deployments.
---

This page covers the system collections that describe the data model itself (collections, fields, relations) and the operator endpoints that move that model between deployments (`/schema/snapshot`, `/schema/diff`, `/schema/apply`).

These are not collection-CRUD-shaped surfaces in the same way `/users` and `/files` are. The records are keyed by collection name and field tuples rather than numeric IDs, the route shapes diverge from the standard items pattern, and only some of the standard query options apply. Read the per-collection sections for the specifics.

## Collections (`/collections`)

A row in `directus_collections` describes one collection in your data model. The row stores the collection's display metadata (icon, color, note, sort order, archive configuration) and references the underlying SQL table, but it does not own the table's columns; those are described by `directus_fields`.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/collections` | List all collections in the data model. |
| `SEARCH` | `/collections` | Read collections with the request body (`keys` array supported; full filter DSL is not). |
| `GET` | `/collections/<collection>` | Read a single collection. The path parameter is the collection name. |
| `POST` | `/collections` | Create one or many collections. Creating through the API also creates the underlying SQL table. |
| `PATCH` | `/collections` | Update many collections. Body is an array of records, each with a `collection` key naming the collection to update. The `keys + data` and `query + data` shapes are not registered. |
| `PATCH` | `/collections/<collection>` | Update a single collection. |
| `DELETE` | `/collections/<collection>` | Delete a single collection. Drops the underlying SQL table along with the metadata row. There is no batch-delete endpoint. |

The path parameter on single-collection routes is the collection name itself, not a numeric ID. Collection names are user-defined strings (typically lowercase, underscore-separated).

### Collection record fields

- **`collection`** — primary key. The collection's name. User-defined collections use any string; system collections are named `directus_*`.
- **`meta`** — an object containing the platform's display metadata: `icon`, `color`, `note`, `hidden`, `singleton`, `translations`, `display_template`, `sort_field`, `archive_field`, `archive_value`, `unarchive_value`, `archive_app_filter`, `item_duplication_fields`, `accountability`, `sort`, `group`, `collapse`. Each is null when not set (with `accountability` accepting `all`, `activity`, or `null`, and `collapse` accepting `open`, `closed`, or `locked`).
- **`schema`** — an object describing the underlying SQL table: `name`, `comment`, `schema` (database schema name on Postgres). When the collection is a "folder" (a virtual collection used purely for grouping in the admin app, with no underlying table), `schema` is `null`.

System collections (`directus_*`) appear in `GET /collections` for admin readers but are filtered out of regular query results for non-admins.

## Fields (`/fields`)

A row in `directus_fields` describes one field on one collection. Each row carries the field's metadata (interface configuration, display options, validation, special behaviors) alongside a description of the underlying SQL column. The API addresses fields by `(collection, field)`, but each row also carries an internal numeric `id` on its `meta` block; other system tables (the parent-group reference between fields, for example) point at that numeric id rather than at the `(collection, field)` tuple.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/fields` | List every field on every collection. |
| `GET` | `/fields/<collection>` | List every field on one collection. |
| `GET` | `/fields/<collection>/<field>` | Read a single field. |
| `POST` | `/fields/<collection>` | Create a single field on a collection. The request body is one field record. Creating a non-alias field also adds the underlying SQL column. There is no batch-create shape; create multiple fields with sequential calls or through `POST /schema/apply`. |
| `PATCH` | `/fields/<collection>` | Update many fields on a collection. Body is an array of records, each with a `field` key. |
| `PATCH` | `/fields/<collection>/<field>` | Update a single field. |
| `DELETE` | `/fields/<collection>/<field>` | Delete a single field. Drops the underlying SQL column. |

There is no batch-delete endpoint and no top-level `POST /fields` (every create has to specify a target collection).

### Field record fields

Each row carries three blocks. They mirror the schema-snapshot format documented in [Schema as code](/docs/manage/schema-as-code/).

- **`collection`** — the parent collection's name.
- **`field`** — the field's name. Together with `collection`, this is the row's primary key.
- **`type`** — the platform's field type (`string`, `integer`, `boolean`, `json`, `uuid`, `dateTime`, `geometry`, `text`, and so on, plus alias types like `o2m`, `m2m`, `m2a`, `presentation`, `translations`).
- **`meta`** — an object holding interface configuration: `interface`, `options`, `display`, `display_options`, `readonly`, `hidden`, `sort`, `width`, `translations`, `note`, `conditions`, `required`, `group`, `validation`, `validation_message`, `special` (the field's behavior tags like `uuid`, `json`, `cast-boolean`, and so on).
- **`schema`** — an object describing the SQL column: `name`, `table`, `data_type`, `default_value`, `max_length`, `numeric_precision`, `numeric_scale`, `is_nullable`, `is_unique`, `is_primary_key`, `has_auto_increment`, `foreign_key_table`, `foreign_key_column`. For alias-type fields (`o2m`, `m2m`, `m2a`, `presentation`, `translations`), `schema` is `null` because there is no SQL column.

The `special` array on `meta` is the bridge between platform field types and SQL columns. It is what tells the platform to JSON-stringify a value on write and parse it on read, to populate a UUID on insert, to interpret a `boolean` cast from a tinyint, and so on.

## Relations (`/relations`)

A row in `directus_relations` describes one foreign-key relationship between two columns. The platform automatically reads SQL-level foreign keys from the database on startup; explicit `directus_relations` rows let operators describe relations the platform cannot infer (junction tables, many-to-any references, alias relations).

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/relations` | List all relations the platform knows about. |
| `GET` | `/relations/<collection>` | List all relations involving one collection. |
| `GET` | `/relations/<collection>/<field>` | Read a single relation. |
| `POST` | `/relations` | Create one relation. Body must include `collection`, `field`, and the relation's metadata. |
| `PATCH` | `/relations/<collection>/<field>` | Update a single relation. |
| `DELETE` | `/relations/<collection>/<field>` | Delete a single relation. |

There is no batch shape on `/relations` for any verb; every mutation is single-row. Bulk schema changes go through `POST /schema/apply` instead.

### Relation record fields

- **`collection`** — the collection holding the foreign-key column.
- **`field`** — the field on `collection` that points at `related_collection`. Together with `collection`, this is the row's primary key.
- **`related_collection`** — the collection being pointed at. May be null for many-to-any relations, where the related collection is determined by a discriminator field on the same row.
- **`meta`** — an object holding platform-level metadata: `one_field` (the alias field on the related side, if there is one), `one_collection_field` and `one_allowed_collections` (for many-to-any), `junction_field` (the corresponding field on a junction collection, for many-to-many), `sort_field`, `one_deselect_action`.
- **`schema`** — an object describing the SQL-level constraint: `table`, `column`, `foreign_key_table`, `foreign_key_column`, `constraint_name`, `on_update`, `on_delete`. The accepted `on_delete` values are `NO ACTION`, `SET NULL`, `SET DEFAULT`, `CASCADE`, and `RESTRICT`.

For many-to-any relations, `related_collection` is null and `meta.one_collection_field` names the field on `collection` that holds the discriminator value naming the actual related collection per row.

## Schema-as-code endpoints

Three endpoints snapshot, diff, and apply the entire data model across deployments:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/schema/snapshot` | Return the current schema as a snapshot. |
| `POST` | `/schema/diff` | Compute the diff between a submitted snapshot and the current database state. |
| `POST` | `/schema/apply` | Apply a previously-computed diff to the current database. |

These are admin-only and operator-facing rather than per-row CRUD. The two-step diff/apply pattern (with a hash handoff between calls) protects against a third party changing the schema between when the diff was computed and when it is applied. See [Schema as code](/docs/manage/schema-as-code/) for the full reference, including the snapshot file format, the version and vendor portability checks, the hash mechanism, and the relationship with the `cairncms schema snapshot` and `cairncms schema apply` CLI commands.

The endpoints take and return JSON by default. `POST /schema/diff` also accepts YAML and JSON snapshot files as multipart uploads so the same workflow works against snapshot files committed to a repo without parsing them client-side.

## GraphQL

The three collections do not follow the standard generated CRUD shape on `/graphql/system`. The auto-generated roots (`collections`, `fields`, `relations`, `create_*_item`, `update_*_item`, `delete_*_item`) are removed for these collections, and the system endpoint exposes bespoke resolvers in their place:

- **Queries** — `collections`, `collections_by_name`, `fields`, `fields_in_collection`, `fields_by_name`, `relations`, `relations_in_collection`, `relations_by_name`. The shapes mirror the REST routes (`fields_in_collection(collection: "articles")` is the equivalent of `GET /fields/articles`, and so on).
- **Admin-only mutations** — `create_collections_item`, `update_collections_item`, `delete_collections_item`, `create_fields_item`, `update_fields_item`, `delete_fields_item`, `create_relations_item`, `update_relations_item`, `delete_relations_item`. Each takes the same arguments the corresponding REST route does.

The `/schema/*` endpoints are REST-only. There is no GraphQL equivalent because the snapshot payload does not fit cleanly into the GraphQL type system and the diff/apply hash handoff is HTTP-shaped.

## Permission semantics

The three collections are admin-only by default. Operators rarely grant non-admin write access to any of them, since editing the schema through these endpoints (or the `/schema/apply` endpoint) changes the platform's data model live: collections and fields appear or disappear, relations are added or removed, and ongoing requests resolve against the new shape immediately.

Read access to schema metadata is sometimes granted broadly so operator tools can introspect the model. Be specific about which fields are exposed if you grant non-admin read; the `meta` and `schema` blocks include configuration that occasionally references operator-managed defaults.

For non-admin app-access roles, the platform projects minimum read permissions on `directus_collections`, `directus_fields`, and `directus_relations` so the admin app can render the schema-aware UI for those users. (`directus_permissions` also gets a projected self-scoped read so app-access users can see their own permission rules.) These projected permissions never appear as rows in `/permissions`.

## Where to go next

- [Schema as code](/docs/manage/schema-as-code/) — the manage-section reference for the `/schema/*` endpoints, including the YAML snapshot file format and the CLI workflows.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL the field-level `validation` and `meta.conditions` payloads use.
- [Items](/docs/api/items/) — the CRUD endpoints whose shape is generated from the `directus_collections` and `directus_fields` rows on this page.
- [Migration between instances](/docs/manage/migration-between-instances/) — moving data and schema between deployments, where `/schema/*` is one piece.
