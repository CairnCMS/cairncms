---
title: Filters and queries
description: The query parameters shared by REST and GraphQL. Field selection, filtering, sorting, pagination, aggregation, deep queries, and the filter operator reference.
sidebar:
  order: 5
---

Most CairnCMS read endpoints accept a common set of query options. They control which rows match, how the result is sorted and paginated, what fields come back, and what statistics the response carries alongside the data. The same options work in REST as query parameters and in `SEARCH` request bodies. GraphQL exposes a subset of them as arguments and handles the rest through native language features (selections, aliases, nested arguments). The full mapping is in [GraphQL](#graphql) below.

This page documents each option, the filter operators they compose with, and the variables that resolve at request time.

## At a glance

| Option | Purpose | GraphQL equivalent |
|---|---|---|
| `fields` | Field selection, including nested relations. | Native selection set. |
| `filter` | Item-level filter expression. | `filter` argument. |
| `search` | Full-text-style match across all string fields. | `search` argument. |
| `sort` | Result ordering. | `sort` argument. |
| `limit` | Page size. | `limit` argument. |
| `offset` | Skip count. | `offset` argument. |
| `page` | Page number (alternative to `offset`, 1-based). | `page` argument. |
| `aggregate` | Aggregate functions over the result. | Separate `<collection>_aggregated` resolver. |
| `groupBy` | Grouping fields for aggregation. | `groupBy` on the aggregated resolver. |
| `meta` | Extra metadata on the response (counts). | Not exposed; use the aggregated resolver for counts. |
| `deep` | Per-relation query options on nested data. | Arguments on the nested field selection. |
| `alias` | Aliased fields in the output. | Native GraphQL field aliases. |

## Field selection

`fields` controls which columns the response includes. By default, every field the role can read is returned.

```http
GET /items/articles?fields=id,title,published_at
```

Use `*` for "all fields the role can read":

```http
GET /items/articles?fields=*
```

Nested relations follow the dot path of the relation field:

```http
GET /items/articles?fields=id,title,author.name,author.avatar.id
```

Combine wildcards with explicit paths to control depth:

```http
GET /items/articles?fields=*,author.name
```

`*.*` selects one level of all relations. `*.*.*` selects two levels, and so on. Use this carefully; deep wildcards on highly relational schemas produce expensive queries.

For many-to-any relations, use the `:collection` syntax to scope fields per related collection:

```http
GET /items/pages?fields=sections.item:headings.title,sections.item:paragraphs.body
```

## Filter

`filter` is the item-level expression evaluated against each row. The shape is a JSON object that nests field names, operators, and values.

```http
GET /items/articles?filter[status][_eq]=published
```

In a `SEARCH` body or GraphQL argument, the same shape is passed as an object:

```json
{
  "query": {
    "filter": { "status": { "_eq": "published" } }
  }
}
```

### Logical composition

Combine clauses with `_and` and `_or`:

```json
{
  "filter": {
    "_and": [
      { "status": { "_eq": "published" } },
      { "_or": [
          { "category": { "_eq": "news" } },
          { "category": { "_eq": "features" } }
      ] }
    ]
  }
}
```

The implicit operator at any level is `_and`, so a top-level object with multiple field keys is shorthand for `_and` over those fields.

### Filtering across relations

Use the relation's field name and dot into the related collection:

```json
{
  "filter": { "author": { "status": { "_eq": "active" } } }
}
```

For one-to-many and many-to-many relations, two helper operators exist:

- `_some`: matches if any related row matches the inner filter.
- `_none`: matches if no related row matches.

```json
{
  "filter": { "tags": { "_some": { "label": { "_eq": "featured" } } } }
}
```

### Filter variables

Three runtime values resolve inside filters at the moment the query runs:

- `$NOW`: current timestamp.
- `$CURRENT_USER`: ID of the authenticated user.
- `$CURRENT_ROLE`: role ID of the authenticated user.

```json
{
  "filter": {
    "_and": [
      { "publish_at": { "_lte": "$NOW" } },
      { "author": { "_eq": "$CURRENT_USER" } }
    ]
  }
}
```

Filter variables are particularly useful in role permissions, where the same rule applies to every user but resolves to the caller's ID at request time. Variables work the same way in API filters and in permission filters.

`$NOW` accepts an offset suffix for relative times, written as `$NOW(<duration>)` where duration is an ISO 8601-style segment:

```json
{ "publish_at": { "_lte": "$NOW(-7 days)" } }
```

## Filter operators

| Operator | Meaning |
|---|---|
| `_eq` | Equal to. |
| `_neq` | Not equal to. |
| `_ieq` | Case-insensitive equal. |
| `_nieq` | Case-insensitive not equal. |
| `_lt`, `_lte`, `_gt`, `_gte` | Less / greater than (or equal to). |
| `_in` | In the given array. |
| `_nin` | Not in the given array. |
| `_between` | Between two values (inclusive). Value is `[low, high]`. |
| `_nbetween` | Not between two values. |
| `_null` | Field is `NULL`. Pass `true`, or `false` for the inverse. |
| `_nnull` | Field is not `NULL`. Pass `true`, or `false` for the inverse. |
| `_empty` | Field is empty (zero-length string or empty array). |
| `_nempty` | Field is not empty. |
| `_contains` | String contains the substring (case sensitive). |
| `_ncontains` | String does not contain the substring. |
| `_icontains` | Case-insensitive contains. |
| `_nicontains` | Case-insensitive not contains. |
| `_starts_with` | String starts with the substring. |
| `_nstarts_with` | Does not start with. |
| `_istarts_with` | Case-insensitive starts with. |
| `_nistarts_with` | Case-insensitive does not start with. |
| `_ends_with` | String ends with the substring. |
| `_nends_with` | Does not end with. |
| `_iends_with` | Case-insensitive ends with. |
| `_niends_with` | Case-insensitive does not end with. |
| `_intersects` | Geometry intersects another geometry. |
| `_nintersects` | Geometry does not intersect. |
| `_intersects_bbox` | Geometry intersects a bounding box. |
| `_nintersects_bbox` | Geometry does not intersect a bounding box. |

Operators that take no value (`_null`, `_nnull`, `_empty`, `_nempty`) accept `true` to apply the rule and `false` to apply its inverse. The case-insensitive variants are useful for fields that store user-supplied text without consistent casing (email addresses, search terms, tags).

`_in` and `_nin` with an empty array preserve their mathematical meaning: `_in: []` matches no rows (the value is in an empty set, which is impossible), while `_nin: []` matches every row (the value is not in an empty set, which is trivially true). Permission rules expressed with these operators behave the same way; an `_in: []` permission filter denies all matches, and a `_nin: []` permission filter denies nothing.

## Read-derived query operands require field-read authority

Several query options derive information from field values rather than returning the value directly: `filter` row inclusion, `search` substring matching, `sort` ordering, `groupBy` bucketing, value-derived aggregates (`min`, `max`, `sum`, `sumDistinct`, `avg`, `avgDistinct`), and `alias` mappings. The platform enforces that operands of these operations must be readable by the caller. A caller cannot use a field as an indirect oracle for a value they cannot read directly.

- **Filter** — an operand the caller cannot read is rejected with `403 FORBIDDEN`.
- **Search** — search runs only across fields the caller can read. Other string fields are excluded from the substring match.
- **Sort** — an explicit sort by an unread field is rejected with `403`. If the schema's configured `sort_field` is unread by the caller and no explicit sort is supplied, the request falls back to primary-key order rather than refusing the listing.
- **`groupBy`** — an operand the caller cannot read is rejected with `403`.
- **Aggregates** — every aggregate operand requires field-read permission, except `*` (used by `countAll` and `count('*')`). On an unread field, all aggregates with a specific field operand are rejected with `403`. On concealed fields specifically, value-derived aggregates (`min`, `max`, `sum`, `sumDistinct`, `avg`, `avgDistinct`) are rejected with `400 INVALID_QUERY` even when the caller has read permission on the field; count-style aggregates (`count`, `countDistinct`) on a permitted concealed field are not blocked by the conceal rule because they return an integer count and do not leak the value.
- **Aliases** — an alias must resolve to a field the caller can read; aliases do not bypass field permissions.

Concealed fields are subject to additional restrictions on top of normal read permissions and apply uniformly to all callers, including admins. See [Concealed fields](/docs/guides/permissions/#concealed-fields).

## Search

`search` is a single-string match across all string fields the role can read.

```http
GET /items/articles?search=climate
```

The implementation is a `LIKE`-style match per field combined with `OR`. It is not a full-text engine and does not stem, rank, or tokenize. For projects that need real search relevance, integrate a dedicated search index (Meilisearch, Typesense, or similar) and let CairnCMS hold the canonical data.

## Sort

`sort` accepts a field name, prefixed with `-` for descending order, or an array of fields for multi-key sort:

```http
GET /items/articles?sort=-published_at,title
```

Nested fields work with dot notation:

```http
GET /items/articles?sort=author.name
```

Sort operands are subject to field-read authority. An explicit sort by a field the caller cannot read is rejected with `403`. When no explicit sort is supplied and the collection's configured `sort_field` is unread by the caller, the implicit default is normalized to primary-key order rather than rejecting the listing. See [Read-derived query operands](#read-derived-query-operands-require-field-read-authority) for the full rule.

## Pagination

Two modes:

- `limit` and `offset`:

```http
GET /items/articles?limit=20&offset=40
```

- `limit` and `page`:

```http
GET /items/articles?limit=20&page=3
```

`page` is 1-based, so `page=1` returns the first `limit` rows, `page=2` skips the first `limit` and returns the next, and so on. The platform computes the offset internally as `limit * (page - 1)`. The example above returns rows 41 through 60.

Pick whichever knob fits your client. `offset` is a raw skip count; `page` is a friendlier shape when the UI thinks in pages.

`limit=-1` asks for every matching row. When `QUERY_LIMIT_MAX` is unset or `-1`, it returns the full result set with no cap. When a finite maximum is configured, it returns at most `QUERY_LIMIT_MAX` rows. Reach for `limit=-1` when the result set is bounded by a strict filter, such as a singleton-style read. Avoid it on open queries against large collections, where it can produce arbitrarily large responses and slow queries.

A list endpoint that omits `limit` returns `QUERY_LIMIT_DEFAULT` rows, `100` by default, and `QUERY_LIMIT_MAX` caps each list separately, the top-level list and every nested relational list, rather than the total object count of a response. An explicit `limit` larger than a finite `QUERY_LIMIT_MAX` is rejected as an invalid query rather than clamped. Both variables are described under [Query limits](/docs/manage/configuration/#query-limits). Reads through `/permissions` force an unbounded read after validation, so an accepted `limit` or `page` does not truncate the permissions matching your query, and the admin app can load a role's permission set in full.

## Aggregate and groupBy

`aggregate` runs a function over the result set without returning per-row data:

```http
GET /items/articles?aggregate[count]=*
```

The supported functions:

| Function | Meaning |
|---|---|
| `count` | Row count. |
| `countDistinct` | Distinct value count. |
| `sum` | Sum of a numeric field. |
| `sumDistinct` | Sum of distinct values. |
| `avg` | Mean of a numeric field. |
| `avgDistinct` | Mean of distinct values. |
| `min`, `max` | Minimum / maximum of a field. |

Each function takes a field name (or `*` for `count`):

```http
GET /items/articles?aggregate[avg]=read_time&aggregate[max]=word_count
```

`groupBy` groups the result for the aggregate to operate over:

```http
GET /items/articles?aggregate[count]=*&groupBy=category
```

The response is one row per group, each carrying the group keys and the aggregate values.

`filter` and `search` apply before the aggregation runs, so an aggregate over a filtered set returns the count of matching rows.

## Meta

`meta` adds extra fields to the response envelope alongside `data`:

| Key | Meaning |
|---|---|
| `total_count` | Count of all rows in the collection (ignores filter). |
| `filter_count` | Count of rows matching the request's filter. |

```http
GET /items/articles?meta=total_count,filter_count
```

`meta=*` is shorthand for both. Combined with `filter`, the response shows how many rows would match without pagination, which is what UIs need to render "showing 1-20 of 142" labels.

`meta` only applies on list reads. Single-item reads, creates, and updates ignore it.

## Deep

`deep` applies query options to nested relations independently of the top-level query.

```http
GET /items/articles?fields=id,title,comments.body&deep[comments][_filter][approved][_eq]=true&deep[comments][_limit]=5
```

The shape is `deep[<relation>][<option>]=<value>`. Most top-level options work in `deep`: `_filter`, `_sort`, `_limit`, `_offset`, `_page`, `_search`, `_fields`. Nested deeps are supported with another level of `deep[<inner-relation>]`.

In a `SEARCH` body or GraphQL argument, `deep` is an object of objects keyed by relation name:

```json
{
  "deep": {
    "comments": {
      "_filter": { "approved": { "_eq": true } },
      "_limit": 5
    }
  }
}
```

`deep` is the right tool for fetching a constrained subset of related rows. Use it for "the article and its three most recent comments" rather than relying on a separate request to fetch the comments and stitching the results together client-side.

## Alias

`alias` renames fields in the output. The map is keyed by alias and points at a top-level field on the same collection:

```http
GET /items/articles?alias[headline]=title&fields=headline
```

Both the key and the value must be plain field names. Periods are rejected by query validation, so `alias` cannot rename a relation path like `author.name` to a flat field. To project a related field under a different name, use a GraphQL alias instead, or read the field directly and rename it client-side.

## REST query encoding

REST encodes the same query as URL parameters using bracket notation:

| Shape | Encoding |
|---|---|
| `fields=[a, b, c]` | `fields=a,b,c` or `fields[]=a&fields[]=b&fields[]=c` |
| `filter[status][_eq]=published` | `filter%5Bstatus%5D%5B_eq%5D=published` |
| `sort=[-published_at, title]` | `sort=-published_at,title` |
| `meta=*` | `meta=%2A` |

For deeply-nested filters or large `fields[]` arrays, the URL hits length limits. Use `SEARCH` (see [SEARCH method](/docs/api/introduction/#the-search-method)) to put the same query in the request body instead.

## GraphQL

GraphQL accepts a subset of these options as arguments on the collection query:

```graphql
query {
  articles(
    filter: { status: { _eq: "published" } }
    sort: ["-published_at"]
    limit: 20
    offset: 0
  ) {
    id
    title
    author { name }
  }
}
```

The supported arguments are `filter`, `sort`, `limit`, `offset`, `page`, and `search`. The argument names match REST one-to-one.

Three options are not exposed as collection arguments because GraphQL handles them through native language features:

- **Field selection** uses GraphQL's selection set. The `id`, `title`, and `author { name }` lines above are the equivalent of REST's `fields=id,title,author.name`.
- **Aliases** use GraphQL's native field-aliasing syntax. Write `headline: title` in the selection to rename `title` to `headline` in the response, or `byline: author { name }` to project a related field under a different name.
- **Deep query options** are arguments on the nested field, not on the parent collection. To filter a relation, set arguments inside the nested selection: `comments(filter: { approved: { _eq: true } }, limit: 5) { id body }`.

Aggregation and counts live on a separate resolver named `<collection>_aggregated`. It accepts `groupBy`, `filter`, `limit`, `offset`, `page`, `search`, and `sort`, and returns one row per group with the requested aggregate functions:

```graphql
query {
  articles_aggregated(groupBy: ["category"]) {
    group
    count {
      id
    }
  }
}
```

REST's `meta` option is not exposed in GraphQL. Use `<collection>_aggregated` with a `count` selection to get the equivalent counts.

## Where to go next

- [Items](/docs/api/items/) — the endpoints these queries operate on.
- [Files](/docs/api/files/) — the same query options applied to `/files`.
- [GraphQL](/docs/api/graphql/) — schema introspection, query depth, and the user / system endpoint split.
- [Permissions](/docs/guides/permissions/) — how role-level filters compose with request-level filters.
