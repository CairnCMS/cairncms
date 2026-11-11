---
title: Items
description: Read, create, update, and delete items in user-defined collections — single, batch, query-based, and relational writes through one consistent API.
sidebar:
  order: 3
---

Items are the rows in your user-defined collections. The platform exposes them through a single REST endpoint family at `/items/<collection>` and a corresponding set of GraphQL operations on `/graphql`. The same query DSL works across both. See [Filters and queries](/docs/api/filters-and-queries/) for the full reference on query parameters.

This page covers the endpoint shapes, the batch and query-based variants, and how relational writes work.

## The endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/items/<collection>` | List items, optionally filtered/paginated/sorted. |
| `SEARCH` | `/items/<collection>` | Read items with the request body — either a `query` object (same shape as `GET` parameters) or a `keys` array to fetch a specific set of primary keys. |
| `GET` | `/items/<collection>/<id>` | Read a single item. |
| `POST` | `/items/<collection>` | Create one item or many (array body). |
| `PATCH` | `/items/<collection>/<id>` | Update a single item. |
| `PATCH` | `/items/<collection>` | Update many items (three body shapes). |
| `DELETE` | `/items/<collection>/<id>` | Delete a single item. |
| `DELETE` | `/items/<collection>` | Delete many items (three body shapes). |

`<collection>` is the collection's API name. The endpoint is reserved for user-defined collections; collection names that begin with `directus_` are not accepted on `/items/<collection>`. System collections have their own top-level paths (`/users`, `/files`, `/roles`, etc.). See [System collections](/docs/api/system-collections/) for those.

`<id>` is the primary key. CairnCMS supports integer and UUID primary keys; the type matches whatever the collection was created with.

## List items

```http
GET /items/articles?fields=id,title,author.name&filter[status][_eq]=published&sort=-published_at&limit=20
```

Returns items as an array, wrapped in the standard envelope:

```json
{
  "data": [
    { "id": 1, "title": "First", "author": { "name": "Alex" } },
    { "id": 2, "title": "Second", "author": { "name": "Jamie" } }
  ]
}
```

When the request includes `meta=*` (or specific keys like `meta=total_count,filter_count`), the envelope adds a `meta` object:

```json
{
  "data": [ ... ],
  "meta": {
    "total_count": 142,
    "filter_count": 23
  }
}
```

`total_count` is the count of items in the collection regardless of filter; `filter_count` is the count after the request's filter is applied. Both ignore pagination.

For deep filters or long `fields[]` arrays that bump up against URL length limits, use `SEARCH` with the query in the body. See [SEARCH method](/docs/api/introduction/#the-search-method).

## Read a single item

```http
GET /items/articles/42?fields=id,title,body,author.name
```

Returns the item:

```json
{
  "data": {
    "id": 42,
    "title": "How something works",
    "body": "...",
    "author": { "name": "Alex" }
  }
}
```

Items the caller cannot read return `403 FORBIDDEN`. Items that genuinely do not exist also return `403`, intentionally, distinguishing "no permission" from "no such item" would leak which IDs exist.

## Create items

A single item:

```http
POST /items/articles
Content-Type: application/json

{
  "title": "A new article",
  "body": "..."
}
```

Many items in one call — pass an array:

```http
POST /items/articles
Content-Type: application/json

[
  { "title": "First" },
  { "title": "Second" }
]
```

The response is the created item (or items), re-read through the sanitized query so `fields` and `deep` apply to the returned shape (`meta` is a list-only concept and does not appear on item-creation responses):

```http
POST /items/articles?fields=id,title,slug
Content-Type: application/json

{ "title": "A new article" }
```

```json
{
  "data": { "id": 51, "title": "A new article", "slug": "a-new-article" }
}
```

If the caller has permission to create but not to read the row they just created, the body is omitted from the response (the create still happens). This matters for service accounts with narrow permissions. Verify the read path explicitly if your client expects a read-back.

## Update a single item

```http
PATCH /items/articles/42
Content-Type: application/json

{
  "title": "Updated title"
}
```

The body is a partial update; only the fields you include are touched. Returns the updated item, re-read through the sanitized query.

## Update many items

Three body shapes, picked by the structure you send:

### Update by primary key list

```http
PATCH /items/articles
Content-Type: application/json

{
  "keys": [42, 43, 44],
  "data": { "status": "published" }
}
```

Applies the same patch (`data`) to every item in `keys`. Returns the updated items.

### Update by query

```http
PATCH /items/articles
Content-Type: application/json

{
  "query": { "filter": { "status": { "_eq": "draft" } } },
  "data": { "status": "review" }
}
```

Updates the items selected by the query. Only items your role can read are eligible. Your role needs read access to the primary key and any filter or sort fields, plus update permission on every selected item. To update items without read access, [specify their primary keys](#update-by-primary-key-list).

Before a bulk update, use `GET` with the same query to review the items it selects.

### Update batch

```http
PATCH /items/articles
Content-Type: application/json

[
  { "id": 42, "title": "First updated" },
  { "id": 43, "title": "Second updated" }
]
```

When the body is an array, each element must include the primary key and gets its own update. This is the right shape when you need different per-item changes in a single request.

## Delete items

A single item:

```http
DELETE /items/articles/42
```

Returns `204 No Content` on success.

Many items by primary-key array:

```http
DELETE /items/articles
Content-Type: application/json

[42, 43, 44]
```

By keys + data:

```http
DELETE /items/articles
Content-Type: application/json

{ "keys": [42, 43, 44] }
```

By query:

```http
DELETE /items/articles
Content-Type: application/json

{ "query": { "filter": { "status": { "_eq": "draft" } } } }
```

Query-based deletes have the same [read-permission requirements as query-based updates](#update-by-query) and require delete permission on every selected item. To delete items without read access, pass their primary keys.

Review the matching items with `GET` before deleting them.

## Singletons

A collection marked as a singleton (the `meta.singleton` flag in the schema) holds at most one item. The intended shape is unkeyed:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/items/<collection>` | Read the singleton. |
| `PATCH` | `/items/<collection>` | Upsert the singleton — creates the row if it does not exist, updates it if it does. |

`POST /items/<collection>` and `PATCH /items/<collection>/<id>` are explicitly blocked for singleton collections (they return `404 ROUTE_NOT_FOUND`) because they don't fit the one-row model. The other `<id>`-keyed shapes (`GET /items/<collection>/<id>`, `DELETE /items/<collection>/<id>`) are not blocked, but they are not part of the intended interface. Treat the unkeyed pair above as the contract.

## Relational writes

The platform supports four relation types: many-to-one, one-to-many, many-to-many, and many-to-any. Each accepts the same write shapes that match how it reads.

### Many-to-one

Submit the related item under the relation field. To create a new related item inline:

```json
{
  "featured_article": { "title": "A new featured article" }
}
```

To assign an existing related item, pass the primary key:

```json
{
  "featured_article": 17
}
```

To update an existing related item inline, pass an object that includes the primary key:

```json
{
  "featured_article": { "id": 17, "title": "Updated title" }
}
```

To clear the relation, pass `null`.

### One-to-many and many-to-many

Use an array to specify the related items to keep, create, or update:

```json
{
  "children": [
    2,
    { "name": "A new child" },
    { "id": 7, "name": "Update existing child 7" }
  ]
}
```

Items omitted from the array are removed from the relationship only if your role can read them. Related items outside your read permissions stay linked.

Use the detailed form to change individual related items without replacing the list:

```json
{
  "children": {
    "create": [{ "name": "A new child" }],
    "update": [{ "id": 7, "name": "Update existing child 7" }],
    "delete": [3]
  }
}
```

To remove related items, your role needs read access to their primary key and the field linking them to the parent. It also needs update permission to unlink an item, or delete permission if removal deletes it. For many-to-many relationships, these permissions apply to the junction collection that stores the links.

Array-form saves require this read access, even when you only update the listed items. Without it, use the detailed form's `create` and `update` operations, and omit `delete` or leave it empty.

### Many-to-any

Many-to-any items carry both a `collection` reference and an `item` payload. Each entry in the array specifies which collection it belongs to and the item to create or assign in that collection:

```json
{
  "sections": [
    {
      "collection": "headings",
      "item": { "title": "Welcome" }
    },
    {
      "collection": "paragraphs",
      "item": { "body": "..." }
    }
  ]
}
```

Updating and deleting many-to-any entries follow the same pattern as many-to-many. Use the detailed form (`create`, `update`, `delete`) for explicit control.

### Parent links

When creating a parent and its related items in one request, leave out the field that links each related item to the parent. CairnCMS sets that link after creating the parent.

If you supply this field in a nested create or update, it must match the parent in the request. A different parent ID or `null` returns `INVALID_PAYLOAD`.

## Permission semantics

Every items request is filtered by the caller's role permissions:

- **Reads** return only the rows the role is permitted to read, and only the fields the role is permitted to read on those rows. Items that do not match the role's item-level filter are simply absent from the result, not 403'd.
- **Writes** apply the role's create/update/delete permissions per row. A batch update against rows the role cannot update fails the entire request rather than partially applying.
- **Field allow-lists** apply on writes too; patches that touch fields outside the allow-list return `FORBIDDEN`.

For the full permissions model, see [Permissions](/docs/guides/permissions/).

## GraphQL

Each user collection generates a corresponding GraphQL type and a set of operations on `/graphql`:

```graphql
query {
  articles(filter: { status: { _eq: "published" } }, limit: 20, sort: "-published_at") {
    id
    title
    author { name }
  }

  articles_by_id(id: 42) {
    id
    title
    body
  }
}

mutation {
  create_articles_item(data: { title: "A new article" }) {
    id
    title
  }

  update_articles_item(id: 42, data: { title: "Updated" }) {
    id
    title
  }

  delete_articles_item(id: 42) {
    id
  }
}
```

Batch equivalents (`create_articles_items`, `update_articles_items`, `delete_articles_items`) take and return arrays. The query options (`filter`, `sort`, `limit`, `offset`, `page`, `search`) work the same way they do in REST.

GraphQL query depth and complexity are bounded by `GRAPHQL_QUERY_TOKEN_LIMIT`. Very deep nested queries against highly relational schemas may bump up against the limit; see [GraphQL](/docs/api/graphql/) for the bounds and how to raise them.

## Where to go next

- [Filters and queries](/docs/api/filters-and-queries/) — the full DSL for `filter`, `fields`, `sort`, `limit`, `offset`, `page`, `search`, `aggregate`, and `groupBy`.
- [Files](/docs/api/files/) — uploading, transforming, and downloading assets, which are themselves items in the system `directus_files` collection.
- [GraphQL](/docs/api/graphql/) — schema introspection, the user/system endpoint split, and feature differences from REST.
- [Permissions](/docs/guides/permissions/) — the operator-side model that governs what every items request can read and write.
