---
title: Access control
description: REST and GraphQL surfaces for users, roles, permissions, and shares, plus the `/config/*` endpoints that snapshot and apply role and permission state.
---

This page covers the four system collections that together make up CairnCMS's access-control layer (users, roles, permissions, shares) and the `/config/*` endpoints that move role and permission state between deployments. Each collection follows the standard CRUD shape documented in [Items](/docs/api/items/), so this page focuses on the per-collection field shapes, the bespoke endpoints that sit alongside the standard CRUD, and the cross-cutting semantics of the access-control surface.

## Users (`/users`)

The user record is what every authenticated request resolves to. The collection has the standard CRUD shape under `/users` plus several user-specific endpoints for the current user, invitations, and TFA setup.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/users` | List users. |
| `SEARCH` | `/users` | Read users with the request body. |
| `GET` | `/users/me` | The current authenticated user. |
| `GET` | `/users/<id>` | Read a single user. |
| `POST` | `/users` | Create one or many users. |
| `PATCH` | `/users` | Update many users (three body shapes). |
| `PATCH` | `/users/me` | Update the current authenticated user. |
| `PATCH` | `/users/me/track/page` | Record the last admin app page the user visited. |
| `PATCH` | `/users/<id>` | Update a single user. |
| `DELETE` | `/users` | Delete many users. |
| `DELETE` | `/users/<id>` | Delete a single user. |
| `POST` | `/users/invite` | Email an invitation to one or more recipients. |
| `POST` | `/users/invite/accept` | Accept an invitation and set the password. |
| `POST` | `/users/me/tfa/generate` | Begin TFA enrollment for the current user. |
| `POST` | `/users/me/tfa/enable` | Complete TFA enrollment. |
| `POST` | `/users/me/tfa/disable` | Disable TFA for the current user. |
| `POST` | `/users/<id>/tfa/disable` | Admin-only: disable TFA for another user. |

### User record fields

The user record carries identity, account state, and role assignment:

- **`id`** (UUID) — primary key.
- **`first_name`**, **`last_name`**, **`email`** — operator-set identity fields.
- **`password`** — Argon2 hash. Always omitted on read; only writable by self or by an admin.
- **`location`**, **`title`**, **`description`**, **`tags`**, **`avatar`**, **`language`**, **`theme`** — display and preference fields.
- **`role`** — UUID reference to `directus_roles`.
- **`status`** — one of `draft`, `invited`, `active`, `suspended`, `archived`. The auth flow rejects logins for any status other than `active`.
- **`token`** — static token. Stored plain text; admin-readable only by default.
- **`tfa_secret`** — TOTP secret. Always omitted on read; written through the TFA endpoints.
- **`provider`**, **`external_identifier`** — populated for SSO users to track which provider authenticated them.
- **`auth_data`** — provider-specific data captured during SSO login.
- **`last_access`**, **`last_page`** — read-tracking fields populated by the auth flow and `/users/me/track/page`.

### `GET /users/me` and `PATCH /users/me`

Convenience routes that resolve to the authenticated user without requiring the caller to know their own ID. Both accept the same query options as `/users/<id>` and `PATCH /users/<id>`.

These routes do not bypass permissions. `PATCH /users/me` runs through the normal accountability path, so a user can update only the fields their role grants update permission on. The default app-access self-update permission covers a limited preference-style field set (theme, language, avatar, and so on); it does not unconditionally grant edit access to the user record. Roles that need broader self-update have to grant it explicitly through `directus_permissions`.

### `POST /users/invite`

Invites one or more recipients by email, optionally pointing at a custom invitation URL.

```http
POST /users/invite
Content-Type: application/json

{
  "email": ["user@example.com", "another@example.com"],
  "role": "<role-uuid>",
  "invite_url": "https://app.example.com/accept-invite"
}
```

`email` accepts a single email or an array. `role` is the UUID of the role to assign on acceptance. `invite_url` is optional; without it, the email points at `<PUBLIC_URL>/admin/accept-invite`. When supplied, the URL must be on the configured `USER_INVITE_URL_ALLOW_LIST` to prevent open-redirect attacks.

### `POST /users/invite/accept`

Completes an invitation. The `token` comes from the URL the recipient receives in their email; `password` is the new account's password.

```http
POST /users/invite/accept
Content-Type: application/json

{
  "token": "<token-from-email>",
  "password": "<new-password>"
}
```

On success, the invited user's `status` flips to `active` and the password is set.

### TFA endpoints

The TFA endpoints are documented in [Authentication / Two-factor authentication](/docs/api/authentication/#two-factor-authentication). The admin-only `POST /users/<id>/tfa/disable` is the bypass for a user who has lost their TFA device.

## Roles (`/roles`)

A role is a named set of access capabilities. Users belong to a role; permissions belong to a role; the platform applies the role's access flags and IP restrictions to every authenticated request.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/roles` | List roles. |
| `SEARCH` | `/roles` | Read roles with the request body. |
| `GET` | `/roles/<id>` | Read a single role. |
| `POST` | `/roles` | Create one or many roles. |
| `PATCH` | `/roles` | Update many roles. |
| `PATCH` | `/roles/<id>` | Update a single role. |
| `DELETE` | `/roles` | Delete many roles. |
| `DELETE` | `/roles/<id>` | Delete a single role. |

### Role record fields

- **`id`** (UUID) — primary key.
- **`key`** — short stable identifier used by config-as-code. If a role is created without a `key`, the service derives one from `name` (lowercased, normalized, deduplicated). The Public role's key is `public` and is reserved. Once set, a role's key cannot be changed; create a new role and migrate users instead.
- **`name`** — display name.
- **`icon`**, **`description`** — display metadata.
- **`admin_access`** (bool) — when `true`, all permission checks are bypassed. Admins can read and write everything regardless of the permissions table.
- **`app_access`** (bool) — when `true`, the role can sign into the admin app and gets the platform-managed minimum permissions on system collections required for the app to function.
- **`enforce_tfa`** (bool) — when `true`, members of the role are expected to enroll in TFA. The flag is policy carried on the role; the API does not gate requests behind it. See [Authentication / Two-factor authentication](/docs/api/authentication/#two-factor-authentication).
- **`ip_access`** — comma-separated list of allowed source IPs (empty string for unrestricted).
- **`users`** — alias field listing the users assigned to this role.

### The Public role

A reserved role with the sentinel UUID `00000000-0000-0000-0000-000000000000` and the key `public`. Permissions assigned to this role apply to unauthenticated requests. The platform protects it from deletion and from being assigned to a user; config-as-code captures its permissions but not the role record itself. See [Permissions](/docs/guides/permissions/) for the full operator-side model.

The "no admin role left after this delete" guard at the engine level enforces that at least one role with `admin_access: true` always exists. There is no override.

## Permissions (`/permissions`)

A permission row is a tuple of role, collection, and action plus the rules that gate that action. Every read, create, update, and delete the platform performs is filtered by the calling role's permissions on the targeted collection.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/permissions` | List permissions. |
| `SEARCH` | `/permissions` | Read permissions with the request body. |
| `GET` | `/permissions/<id>` | Read a single permission. |
| `POST` | `/permissions` | Create one or many permissions. |
| `PATCH` | `/permissions` | Update many permissions. |
| `PATCH` | `/permissions/<id>` | Update a single permission. |
| `DELETE` | `/permissions` | Delete many permissions. |
| `DELETE` | `/permissions/<id>` | Delete a single permission. |

### Permission record fields

- **`id`** (auto-incrementing integer) — primary key.
- **`role`** — UUID of the role this permission applies to.
- **`collection`** — the collection name the permission gates.
- **`action`** — one of `create`, `read`, `update`, `delete`, `comment`, `share`.
- **`permissions`** — a filter expression evaluated against the row to decide whether the action is allowed. Uses the same query DSL as request-level filters; see [Filters and queries](/docs/api/filters-and-queries/).
- **`validation`** — a filter expression evaluated against the incoming payload for create and update actions. Failures return `FAILED_VALIDATION`.
- **`presets`** — default values automatically merged into create payloads.
- **`fields`** — array of field names the role is allowed to see (on read) or modify (on create/update). The wildcard `*` allows all fields.

A read or write that matches no permission row for a non-admin role is denied. The `permissions`, `validation`, and `presets` filters can reference filter variables (`$NOW`, `$CURRENT_USER`, `$CURRENT_ROLE`) to scope rules per caller.

Permissions on system collections work the same way as permissions on user collections, with one caveat: the platform-managed minimum permissions for app-access roles are projected at read time rather than stored as rows, so they are invisible to `/permissions` queries. See [Config as code / What a config snapshot captures](/docs/manage/config-as-code/#what-a-config-snapshot-captures) for the full picture.

## Shares (`/shares`)

A share is a public-link grant that lets unauthenticated visitors view a specific item with a specific role's permissions. Useful for sharing a draft article with an external reviewer, exposing a private dashboard to a stakeholder, and similar scoped-access scenarios.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/shares` | List shares. |
| `SEARCH` | `/shares` | Read shares with the request body. |
| `GET` | `/shares/<id>` | Read a single share. |
| `GET` | `/shares/info/<id>` | Public-readable subset of share metadata (password requirement, validity dates). |
| `POST` | `/shares` | Create one or many shares. |
| `PATCH` | `/shares` | Update many shares. |
| `PATCH` | `/shares/<id>` | Update a single share. |
| `DELETE` | `/shares` | Delete many shares. |
| `DELETE` | `/shares/<id>` | Delete a single share. |
| `POST` | `/shares/auth` | Exchange a share ID and optional password for a scoped access token. |
| `POST` | `/shares/invite` | Email a share link to one or more recipients. |

### Share record fields

- **`id`** (UUID) — primary key. Used in the shareable URL.
- **`name`** — operator-set label.
- **`collection`**, **`item`** — the row the share grants access to.
- **`role`** — UUID of the role whose permissions apply to share visitors. Often a custom read-only role with a narrow filter.
- **`password`** — optional password gating the share. Stored hashed; visitors authenticate by submitting the password to `/shares/auth`.
- **`max_uses`** — optional cap on how many times the share can be activated.
- **`times_used`** — counter incremented on each successful activation.
- **`date_start`**, **`date_end`** — optional validity window.
- **`date_created`**, **`user_created`** — accountability.

### `POST /shares/auth`

The visitor-side login. Returns an access token scoped to the share's role and item.

```http
POST /shares/auth
Content-Type: application/json

{
  "share": "<share-id>",
  "password": "<password-if-required>"
}
```

The response body carries `access_token` and `expires` in the standard `data` envelope. The refresh token is set as the configured refresh-token cookie rather than returned in the body, so visitor clients in a browser context get automatic refresh without having to handle the token directly. The returned access token works the same way a regular access token does, but resolves to a constrained accountability that only sees the shared item.

### `GET /shares/info/<id>`

A public endpoint (no token required) that returns the bare minimum needed to render a share-access UI: whether a password is required, whether the share is currently within its validity window, and how many uses remain. The full record is not exposed; clients call this before prompting for a password.

### `POST /shares/invite`

Sends share-link emails to one or more recipients. Requires create permission on `directus_shares`.

```http
POST /shares/invite
Content-Type: application/json

{
  "share": "<share-id>",
  "emails": ["reviewer@example.com"]
}
```

The email contains the share URL with the share's ID embedded. The invitation does not include the password (if one is set); the operator must communicate that out-of-band.

## Config-as-code endpoints

Two endpoints snapshot and apply role and permission state across deployments:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/config/snapshot` | Return the current roles and permissions as a `CairnConfig` payload. |
| `POST` | `/config/apply` | Apply a `CairnConfig` payload, with optional dry-run and destructive flags. |

These are admin-only and operator-facing rather than collection-CRUD. They wrap the same engine that powers `cairncms config snapshot` and `cairncms config apply`. See [Config as code](/docs/manage/config-as-code/) for the full reference, including the payload shape, the dry-run and destructive flags, the field-level omit-vs-null semantics, and the validation surface.

In short:

- `GET /config/snapshot` returns JSON by default. Pass `?export=yaml` to get a YAML attachment instead.
- `POST /config/apply` accepts JSON or any of three YAML media types. Pass `?dry_run=true` to preview the plan without writing; pass `?destructive=true` to allow deletion of orphan roles and permissions.

There is no `/config/diff` endpoint. The apply endpoint computes the plan internally on every call.

## GraphQL

All four collections are exposed on `/graphql/system` with the standard generated CRUD shape (`users`, `users_by_id`, `create_users_item`, etc.; same for `roles`, `permissions`, `shares`). Filter, sort, and pagination arguments work the same way as on user collections; see [Filters and queries / GraphQL](/docs/api/filters-and-queries/#graphql).

The auth mutations on `/graphql/system` are documented in [Authentication / GraphQL](/docs/api/authentication/#graphql). They include `users_invite`, `users_invite_accept`, and the current-user TFA mutations (`users_me_tfa_generate`, `users_me_tfa_enable`, `users_me_tfa_disable`). The admin-only `POST /users/<id>/tfa/disable` does not have a GraphQL equivalent; use REST when an admin needs to disable TFA on another user's account.

The config-as-code endpoints are REST-only.

## Permission semantics for these collections

The four access-control collections are gated by their own permissions, which produces a meta-level question: who can edit `directus_permissions`?

By default:

- `directus_users` — app-access roles get read on their own row (a limited field set covering the user's own profile and TFA secret), and update on a similarly-scoped subset of fields (first_name, last_name, email, password, location, title, description, avatar, language, theme, tfa_secret). `PATCH /users/me` runs through the normal accountability path against this projected permission, so the writable field set is exactly what the role permits and not broader. Anything outside that field set requires admin or a custom permission grant.
- `directus_roles` — app-access roles get read on their own role only (filtered by `id: { _eq: $CURRENT_ROLE }`). Writes are admin-only.
- `directus_permissions` — app-access roles get read on permissions belonging to their own role (filtered by `role: { _eq: $CURRENT_ROLE }`). Writes are admin-only.
- `directus_shares` — app-access roles get read on shares they themselves created (filtered by `user_created: { _eq: $CURRENT_USER }`). Create, update, and delete are admin-only by default; operators frequently grant create access to specific roles that need to issue shares.

Granting non-admin write access to `directus_permissions` is a privilege escalation surface (a role with permission to edit permissions can grant itself anything). Treat any grant on `directus_permissions` outside of admin as a deliberate decision with the corresponding scrutiny.

## Where to go next

- [Authentication](/docs/api/authentication/) — the auth, TFA, and password-reset flows that work against the user collection.
- [Filters and queries](/docs/api/filters-and-queries/) — the filter DSL used by both request-level filters and permission rules.
- [Permissions](/docs/guides/permissions/) — the operator-side model for designing role and permission sets.
- [Config as code](/docs/manage/config-as-code/) — the full reference for the `/config/*` endpoints and the CLI equivalents.
- [Users](/docs/guides/users/) — the operator-side workflows for inviting, suspending, and managing users in the admin app.
