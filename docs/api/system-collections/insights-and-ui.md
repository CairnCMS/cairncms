---
title: Insights and UI
description: REST and GraphQL surfaces for dashboards, panels, and notifications. The dashboard composition surface plus the user-facing notification feed.
---

Three system collections handle user-facing UI state in CairnCMS: **dashboards** are the top-level Insights views, **panels** are the visualizations placed on a dashboard, and **notifications** are the messages that show up in the user's notification feed (and trigger emails). All three follow the standard CRUD shape with no bespoke endpoints.

## Dashboards (`/dashboards`)

A dashboard is a named, icon'd container for panels. The Insights module shows a dashboard list; selecting one loads the dashboard's panels into a grid layout.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/dashboards` | List dashboards. |
| `SEARCH` | `/dashboards` | Read dashboards with the request body. |
| `GET` | `/dashboards/<id>` | Read a single dashboard. |
| `POST` | `/dashboards` | Create one or many dashboards. |
| `PATCH` | `/dashboards` | Update many dashboards (three body shapes). |
| `PATCH` | `/dashboards/<id>` | Update a single dashboard. |
| `DELETE` | `/dashboards` | Delete many dashboards. |
| `DELETE` | `/dashboards/<id>` | Delete a single dashboard. |

### Dashboard record fields

- **`id`** (UUID) — primary key.
- **`name`** — display name shown in the Insights module's dashboard list.
- **`icon`**, **`color`** — display metadata.
- **`note`** — operator-facing description.
- **`panels`** — alias field listing the panels assigned to this dashboard. The actual relation lives on `directus_panels.dashboard`.
- **`date_created`**, **`user_created`** — accountability.

The dashboard row holds no layout state itself. Panel placement (`position_x`, `position_y`, `width`, `height`) lives on each panel row.

## Panels (`/panels`)

A panel is one visualization on a dashboard. The platform ships several panel types (metric, list, time series, table, label, and so on); custom panel types are added through panel extensions. The panel record stores the panel's identity, its layout coordinates on the dashboard grid, and the panel-type-specific configuration.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/panels` | List panels. |
| `SEARCH` | `/panels` | Read panels with the request body. |
| `GET` | `/panels/<id>` | Read a single panel. |
| `POST` | `/panels` | Create one or many panels. |
| `PATCH` | `/panels` | Update many panels (three body shapes). |
| `PATCH` | `/panels/<id>` | Update a single panel. |
| `DELETE` | `/panels` | Delete many panels. |
| `DELETE` | `/panels/<id>` | Delete a single panel. |

### Panel record fields

- **`id`** (UUID) — primary key.
- **`name`** — display name shown above the panel.
- **`icon`**, **`color`**, **`note`** — display metadata.
- **`type`** — the panel type. Built-in types include `metric`, `list`, `time-series`, `bar-chart`, `pie-chart`, `label`, and `relational-values`. Custom panel extensions add to this list.
- **`show_header`** (bool) — when `true`, the panel renders a header bar with name and icon. When `false`, the panel content fills the grid cell without chrome.
- **`position_x`**, **`position_y`**, **`width`**, **`height`** — coordinates and dimensions in the dashboard's grid (in grid cells).
- **`options`** — JSON object holding panel-type-specific configuration. Shape varies by `type`.
- **`dashboard`** — UUID of the parent dashboard.
- **`date_created`**, **`user_created`** — accountability.

Panels are stored independently of their dashboard; the relationship is a many-to-one from panel to dashboard. The foreign key on `directus_panels.dashboard` is `ON DELETE CASCADE`, so deleting a dashboard removes its panels in the same transaction. Custom tooling does not need to explicitly delete panels before deleting their parent dashboard.

## Notifications (`/notifications`)

A notification is a message addressed to a specific user. It shows up in the user's notification feed in the admin app and, when the user has email notifications enabled, also goes out as an email when the row is created.

### Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/notifications` | List notifications. |
| `SEARCH` | `/notifications` | Read notifications with the request body. |
| `GET` | `/notifications/<id>` | Read a single notification. |
| `POST` | `/notifications` | Create one or many notifications. |
| `PATCH` | `/notifications` | Update many notifications (three body shapes). |
| `PATCH` | `/notifications/<id>` | Update a single notification. |
| `DELETE` | `/notifications` | Delete many notifications. |
| `DELETE` | `/notifications/<id>` | Delete a single notification. |

### Notification record fields

- **`id`** (auto-incrementing integer) — primary key.
- **`timestamp`** — when the notification was created. Auto-populated.
- **`status`** — `inbox` for unread or `archived` for dismissed. The admin app sets this to `archived` when the user dismisses a notification from their feed.
- **`recipient`** — UUID of the user the notification is addressed to. Required.
- **`sender`** — UUID of the user that sent the notification, or null for system-generated notifications.
- **`subject`** — short summary line. Required.
- **`message`** — the notification body.
- **`collection`**, **`item`** — optional reference to a specific collection and item, used to deep-link from the notification feed into the relevant content.

### Email side effect

Creating a notification triggers an email to the recipient, conditional on the recipient having an email address and `email_notifications: true` on their user record. If either is missing, the row is still created but no email is sent. The recipient's `role.app_access` flag affects the email content (app-access users get a management URL in the template; non-app users do not) but does not gate whether the email is sent.

The email is sent synchronously inline with the create, so a slow SMTP provider can slow down `POST /notifications`. Production setups that need consistent latency on notification creates should ensure the SMTP config is performant or use a flow with a Send Email operation queued asynchronously.

For bulk notifications, an array body to `POST /notifications` creates each row and sends the corresponding email per row in sequence. To send the same notification to many recipients, expect the request to take roughly proportional time to the recipient count.

## Permission semantics

Dashboards and panels are open to app-access roles by default. The platform's app-access minimum permissions include create, read, update, and delete on both `directus_dashboards` and `directus_panels`, so app users can create and arrange their own dashboards without explicit operator setup. Operators who want to scope dashboards more tightly (organization-wide dashboards everyone reads but only admins write, for example) need explicit permission rows that override the defaults.

Notifications are open to app-access roles by default for the parts of the workflow a user needs: read access filtered to `recipient: { _eq: $CURRENT_USER }` so users see only their own feed, and update access on the `status` field with the same recipient filter so users can dismiss their own notifications (set `status` to `archived`). The platform projects these permissions at read time rather than storing them as rows in `/permissions`, so they do not appear in the permissions table when listed but still apply.

Create access on `directus_notifications` is admin-only by default. Notifications are usually created by flows or by admin tooling rather than by users directly. Operators who need to let app-access users send notifications to each other must grant create permission explicitly, ideally with a validation rule that constrains `sender` to the calling user.

## GraphQL

All three collections are exposed on `/graphql/system` with the standard generated CRUD shape (`dashboards`, `dashboards_by_id`, `create_dashboards_item`, etc.; same for `panels` and `notifications`). The query DSL options work the same way as in REST; see [Filters and queries / GraphQL](/docs/api/filters-and-queries/#graphql).

The notification email side effect fires on the GraphQL mutation just as it does on the REST `POST`.

## Where to go next

- [Insights](/docs/guides/insights/) — operator-side reference for designing dashboards and configuring panel types.
- [Panels](/docs/develop/extensions/panels/) — building custom panel types as extensions.
- [Filters and queries](/docs/api/filters-and-queries/) — the query DSL stored in panel `options` fields and used to filter notification feeds.
- [Email templates](/docs/develop/email-templates/) — customizing the notification email template.
