---
title: Files
description: Upload, manage, and serve assets — file metadata via /files and the actual bytes (with on-the-fly image transforms) via /assets.
---

CairnCMS exposes files through two parallel surfaces:

- **`/files`** — the metadata API. CRUD over the `directus_files` system collection: create rows, list and search files, update titles and folder assignments, delete records. Same shape as items endpoints, with multipart upload as the addition.
- **`/assets/<id>`** — the bytes API. Streams the actual file content, with optional on-the-fly image transformations, range support, and content-negotiated format selection.

The two are separate by design: client applications fetch metadata once and then build asset URLs against `/assets/<id>` for the bytes. Caching, content delivery, and transform behavior are properties of the asset surface; everything else is on `/files`.

## The file record

Every uploaded file gets a row in `directus_files` with metadata describing it:

- **`id`** (UUID) — primary key, used in `/assets/<id>`.
- **`storage`** — name of the storage location holding the bytes (matches an entry in `STORAGE_LOCATIONS`).
- **`filename_disk`** — the filename in the storage backend.
- **`filename_download`** — the filename the platform suggests when serving the file as an attachment.
- **`title`**, **`description`**, **`tags`**, **`folder`** — operator-managed metadata.
- **`type`** — the file's MIME type, set from the upload's `Content-Type`.
- **`filesize`**, **`width`**, **`height`**, **`duration`**, **`metadata`** — derived properties extracted at upload time.
- **`uploaded_by`**, **`uploaded_on`**, **`modified_by`**, **`modified_on`** — accountability fields.

The platform does not prevent you from adding fields to `directus_files` through the normal field-creation surfaces. The system collection accepts custom fields the same way user collections do. That said, the cleaner pattern for project-specific metadata is usually a related user collection that references `directus_files` rather than columns added directly to the system collection. Custom fields on `directus_files` migrate, snapshot, and apply through schema-as-code, but they tend to entangle the system collection with project-specific shape in ways that are harder to maintain.

## Upload a file

```http
POST /files
Content-Type: multipart/form-data; boundary=...

------boundary
Content-Disposition: form-data; name="title"

A picture of a cat
------boundary
Content-Disposition: form-data; name="folder"

af8c7b6e-1234-5678-9abc-def012345678
------boundary
Content-Disposition: form-data; name="file"; filename="cat.jpg"
Content-Type: image/jpeg

<binary bytes>
------boundary--
```

The metadata fields come first, then the file part. Order matters because the platform creates the `directus_files` row as soon as the file part begins streaming, so any fields after the file part are not picked up. Common fields:

- **`title`** — defaults to a humanized version of the upload filename if omitted.
- **`description`**, **`tags`**, **`folder`** — set the corresponding metadata.
- **`storage`** — the storage location. Defaults to the first entry in `STORAGE_LOCATIONS`.

Multiple files in one multipart body are supported — each `file` part creates one row. Per-file metadata applies to the next file part to follow it (the platform clears the metadata buffer after each file).

The response is the created file record (or array of records when more than one was uploaded), re-read through any `fields` and `deep` query parameters set on the request:

```json
{
  "data": {
    "id": "f7a8e1d2-3456-7890-abcd-ef0123456789",
    "title": "A picture of a cat",
    "filename_download": "cat.jpg",
    "type": "image/jpeg",
    "filesize": 245132,
    "width": 1920,
    "height": 1080
  }
}
```

For a metadata-only row (no bytes which is useful for importing references to externally-stored files), POST a JSON body instead of multipart. The platform creates the row but does not write to storage. The JSON path requires at least `type` (the MIME type) on the body; without it, the request fails with `INVALID_PAYLOAD`. This shape is rarely the right one; see `POST /files/import` below for the common case of pulling a file from a URL.

## Import from a URL

When the file already lives on the public internet, the import endpoint pulls it down server-side:

```http
POST /files/import
Content-Type: application/json

{
  "url": "https://example.com/cat.jpg",
  "data": {
    "title": "A cat from the internet",
    "folder": "af8c7b6e-1234-5678-9abc-def012345678"
  }
}
```

`url` is required and must be an absolute HTTP/HTTPS URL. `data` is an optional object of metadata fields applied to the resulting `directus_files` row. The platform fetches the URL, stores the bytes in the configured storage location, and returns the new file record.

This endpoint is convenient for migrating asset references from another system, where re-uploading every file from the client would be slower than letting the server pull them in parallel.

## List and read file metadata

The list and read shapes match the items API:

```http
GET /files?fields=id,title,type,filesize&filter[type][_starts_with]=image/&sort=-uploaded_on
```

```http
GET /files/<id>?fields=id,title,description,uploaded_by.first_name
```

`SEARCH /files` works the same way `SEARCH /items/<collection>` does. Query in the body, with optional `keys` for fetching a specific set of file IDs. See [Items](/docs/api/items/) for the shared semantics.

## Update file metadata

Single record:

```http
PATCH /files/<id>
Content-Type: application/json

{ "title": "A new title", "folder": "<folder-id>" }
```

Batch:

```http
PATCH /files
Content-Type: application/json

{ "keys": ["<id-1>", "<id-2>"], "data": { "folder": "<folder-id>" } }
```

The same three body shapes that work for `PATCH /items/<collection>` apply: array of records (each with `id`), `{ keys, data }`, or `{ query, data }`. See [Items / Update many items](/docs/api/items/#update-many-items) for the full reference.

## Replace file bytes

`PATCH /files/<id>` also accepts multipart bodies, in which case the bytes for the existing record are replaced:

```http
PATCH /files/<id>
Content-Type: multipart/form-data; boundary=...

------boundary
Content-Disposition: form-data; name="title"

Updated title
------boundary
Content-Disposition: form-data; name="file"; filename="updated.jpg"
Content-Type: image/jpeg

<new bytes>
------boundary--
```

The file ID stays the same, so any references in your data model continue to resolve. The new bytes get a fresh `filename_disk`; the existing storage object is replaced. Cached responses and downstream CDNs may need an explicit purge to reflect the new content.

## Delete files

```http
DELETE /files/<id>
```

Deletes both the `directus_files` row and the underlying bytes from the storage backend.

Batch deletes accept the same three body shapes as items:

```http
DELETE /files
Content-Type: application/json

["<id-1>", "<id-2>", "<id-3>"]
```

Deleting a file that is referenced by another row in the data model defaults to clearing the reference (`SET NULL`). For collections where the file should not silently disappear, set the relation's `On Delete` to `RESTRICT` so the delete is blocked while references exist. See [Files](/docs/guides/files/) for the operator-side configuration.

## Serve an asset

```
GET /assets/<id>
GET /assets/<id>/<filename>
HEAD /assets/<id>
```

Streams the bytes for the file with the given ID. `<filename>` in the path is optional and ignored for resolution. It exists so URLs can carry a sensible filename for download tools and web crawlers without the client needing to look up `filename_download` first.

The default response is `Content-Disposition: inline` (the browser displays the file rather than offering it for download). Pass `?download` to override:

```
GET /assets/<id>?download
```

`HEAD /assets/<id>` returns the same headers without the body, useful for size checks and inspecting `Content-Type`, `Content-Length`, and `Last-Modified` before deciding whether to fetch.

`Range` requests are supported. A request with `Range: bytes=0-1023` returns `206 Partial Content` with the requested byte range; the response includes `Content-Range` and `Content-Length` matching the slice. This is what video players use for seek-without-redownload.

`Cache-Control` is set from `ASSETS_CACHE_TTL` (default `30d`). Asset URLs are immutable in practice — replacing a file's bytes via `PATCH /files/<id>` produces a new `filename_disk` but the asset URL stays the same, so cache invalidation has to come from the operator side.

## Image transformations

Image assets can be transformed on the fly through query parameters on `/assets/<id>`. Two ways to specify the transformation: a preset key, or a free-form transform query.

### Preset keys

The platform ships six built-in keys for common thumbnail sizes:

| Key | Operation |
|---|---|
| `system-small-cover` | 64×64, cropped to cover. |
| `system-small-contain` | width 64, scaled to fit. |
| `system-medium-cover` | 300×300, cropped to cover. |
| `system-medium-contain` | width 300, scaled to fit. |
| `system-large-cover` | 800×800, cropped to cover. |
| `system-large-contain` | width 800, scaled to fit. |

```
GET /assets/<id>?key=system-medium-cover
```

Operators can define additional preset keys through **Settings > Project Settings > Files & Storage** (the `storage_asset_presets` setting). The same `?key=<name>` shape works for project presets.

`?key` cannot be combined with any other transformation parameter. If you need a different transform than what a preset offers, drop the `key` and supply the parameters directly.

### Free-form parameters

Five direct parameters cover the common cases:

```
GET /assets/<id>?width=600&height=400&fit=cover&format=webp&quality=80
```

- **`width`**, **`height`** — output dimensions in pixels. Either or both can be set.
- **`fit`** — one of `cover`, `contain`, `inside`, `outside`. Defaults to `cover` when both `width` and `height` are set.
- **`format`** — `jpg`, `png`, `webp`, `tiff`, `avif`, or `auto` (see below).
- **`quality`** — output quality, 1-100. Encoder-specific; for JPEG and WebP, 80 is a reasonable default.
- **`withoutEnlargement`** — when `true`, prevents scaling images smaller than the target dimensions up.

### Multi-step transforms

For chained operations beyond resize-and-format, the `transforms` parameter takes a JSON array of operation tuples:

```
GET /assets/<id>?transforms=[["resize",{"width":600,"fit":"inside"}],["blur",2],["grayscale"]]
```

Each entry is `[<operation>, <args>?]`. The operation set covers the Sharp library's image methods (resize, rotate, blur, sharpen, grayscale, modulate, and so on). The number of operations per request is bounded by `ASSETS_TRANSFORM_MAX_OPERATIONS` (default `5`); the cap protects against pathological transform requests that would consume CPU on the server.

### Format auto-negotiation

`format=auto` selects the output format based on the request's `Accept` header:

- AVIF if the client advertises `image/avif`.
- WebP if the client advertises `image/webp` and not AVIF.
- JPEG otherwise.

This is the right default for modern browsers. The response includes `Vary: Accept` so caches and CDNs return the right variant per client.

### Project-level transform policy

The **`storage_asset_transform`** project setting controls which transformations are accepted:

- **`all`** — any transformation parameters are accepted.
- **`presets`** — only the system keys and the configured `storage_asset_presets` keys are accepted; arbitrary `width`, `height`, and so on are rejected.
- Any other value — only the system keys work; project presets and arbitrary parameters are rejected.

The `presets` setting is the right hardening choice for public-facing deployments where you want to bound the set of asset variants the server is willing to compute.

## Storage locations

`STORAGE_LOCATIONS` lists the configured locations; each entry has its own `STORAGE_<NAME>_*` configuration block (see [Configuration](/docs/manage/configuration/)). The `directus_files.storage` field on each row records which location holds the bytes for that file.

When uploading without a `storage` field, the platform writes to the first entry in `STORAGE_LOCATIONS`. To upload to a non-default location, include `storage=<name>` as a multipart field before the file part.

Multi-location setups support per-file backend choice (some files on local disk, others in S3) without the client needing to know the storage details — `/assets/<id>` resolves through the row's `storage` value automatically.

## Permission semantics

File metadata permissions are role-driven the same way item permissions are. Permissions are checked against the `directus_files` system collection:

- **Read** — what fields and rows the role can list and fetch through `/files`. Asset access through `/assets/<id>` checks the same read permission against the file's row.
- **Create** — required for upload. Roles without create permission on `directus_files` get `403` on `POST /files` and `POST /files/import`.
- **Update** — required for metadata edits and bytes replacement.
- **Delete** — required for `DELETE /files`.

For asset URLs that should be reachable without a token, configure read permission for the Public role on `directus_files`. Be specific about the filter — granting `read all` to Public exposes every file the platform has stored.

## GraphQL

`directus_files` is part of the system schema, so file metadata operations live on `/graphql/system`:

```graphql
query {
  files(filter: { type: { _starts_with: "image/" } }, limit: 20) {
    id
    title
    width
    height
  }

  files_by_id(id: "<id>") {
    id
    title
    description
  }
}

mutation {
  update_files_item(id: "<id>", data: { title: "Updated" }) {
    id
    title
  }

  delete_files_item(id: "<id>") {
    id
  }
}
```

Upload itself is a multipart-file operation that does not fit GraphQL's single-document model. Use `POST /files` (multipart) or `POST /files/import` (JSON) for the actual upload, then use GraphQL for any subsequent metadata manipulation.

The asset surface (`/assets/<id>`) is REST-only. There is no equivalent in GraphQL, since GraphQL fields are not designed to return raw bytes.

## Where to go next

- [Items](/docs/api/items/) — the shared CRUD shape that `/files` follows.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL used to filter files in `/files` listings.
- [Files](/docs/guides/files/) — the operator-side configuration of folders, presets, and storage backends.
- [Configuration](/docs/manage/configuration/) — `STORAGE_LOCATIONS`, `ASSETS_*` variables, and per-driver settings.
