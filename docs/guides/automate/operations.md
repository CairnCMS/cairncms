---
title: Operations
description: The built-in actions available inside flows, including data CRUD, conditions, scripts, emails, and HTTP requests.
sidebar:
  order: 2
---

Operations are the individual steps inside a flow. CairnCMS ships with a built-in set of operations covering data work, branching, communication, scripting, and HTTP. Custom operations can be added through the extension system.

Every operation appends a value to the [data chain](/docs/guides/automate/#the-data-chain) under its own key. Operations that do not produce data still append `null` so that downstream operations can reference them predictably.

## Condition

Routes execution to the success or failure path based on a filter rule.

- **Condition Rules** — a filter rule evaluated against the data chain

Use this when a flow needs to branch on data the trigger or earlier operations produced. The condition does not generate data of its own; it appends `null` regardless of which path is taken.

If the filter rule itself is misconfigured, the operation appends a debug array describing the misconfiguration.

When used at the end of a flow on a Filter (blocking) Event hook trigger, a failure-path Condition cancels the original database transaction.

## Run Script

Runs custom JavaScript inside an isolated V8 sandbox.

The sandbox is fully isolated from the host: no file system access, network access, or `require()` of built-in or external modules. The script receives the data chain as its argument and returns a JSON-serializable value, which is appended under the operation key. A `console` shim is available and routes to the platform logger.

The script's `process.env` is populated from the operator-allow-listed environment variables (governed separately by `FLOWS_ENV_ALLOW_LIST`).

Throwing inside a script ends the flow. On a Filter (blocking) Event hook trigger, throwing also cancels the original event transaction.

The isolate has a configurable memory and time budget, set via `FLOWS_RUN_SCRIPT_MAX_MEMORY` (default 32, MB) and `FLOWS_RUN_SCRIPT_TIMEOUT` (default 10000, ms). Scripts that exceed either limit are aborted.

## Create Data

Creates one or more items in a collection.

- **Collection** — the target collection
- **Permissions** — the role whose permissions the operation runs under
- **Emit Events** — whether to fire event hooks for this create
- **Payload** — the data to insert

Appends an array of created item IDs.

## Read Data

Reads items from a collection by ID or query.

- **Collection** — the source collection
- **IDs** — specific item IDs to fetch
- **Query** — a filter rule for selecting items
- **Permissions** — the role whose permissions the operation runs under
- **Emit Events** — whether to fire event hooks

Appends the result of the read. With a single ID, this is a single item; with multiple IDs or a query, this is an array of items.

## Update Data

Updates one or more items in a collection by ID or query.

- **Collection** — the target collection
- **IDs** — specific item IDs to update
- **Query** — a filter rule for selecting items to update
- **Payload** — the partial update to apply
- **Permissions** — the role whose permissions the operation runs under
- **Emit Events** — whether to fire event hooks

Appends the updated key(s). With a single ID, this is a single primary key; with multiple IDs or a query, this is an array of primary keys.

## Delete Data

Deletes items from a collection by ID or query.

- **Collection** — the target collection
- **IDs** — specific item IDs to delete
- **Query** — a filter rule for selecting items to delete
- **Permissions** — the role whose permissions the operation runs under
- **Emit Events** — whether to fire event hooks

Appends the deleted key(s). With a single ID, this is a single primary key; with multiple IDs or a query, this is an array of primary keys.

For all four data operations, **Emit Events** controls whether the operation fires its own event hooks. Turn it off when this operation might trip the same flow that contains it, to prevent infinite loops.

## Send Email

Sends one or more emails through the configured email provider.

- **To** — one or more email addresses
- **Subject** — the email subject
- **Type** — `markdown`, `wysiwyg`, or `template`
- **Body** — the email body (when Type is `markdown` or `wysiwyg`)
- **Template** — the name of an installed email template (when Type is `template`; defaults to `base`)
- **Data** — variables to pass into the template (when Type is `template`)

Appends `null`.

## Send Notification

Sends an in-app notification to one or more users.

- **Users** — one or more user UUIDs
- **Title** — the notification title
- **Message** — the notification body
- **Permissions** — the role whose permissions the operation runs under

Appends an array of notification IDs.

## Webhook / Request URL

Sends an HTTP request to an arbitrary URL.

- **Method** — GET, POST, PATCH, DELETE, or others
- **URL** — the target URL
- **Headers** — request headers
- **Request Body** — the body to send

Appends the response under the operation key.

For richer outgoing webhook patterns, see the [Webhooks](/docs/guides/automate/webhooks/) page.

## Trigger Flow

Runs another flow and optionally passes data to it. The other flow must use the **Another flow** trigger.

- **Flow** — the UUID of the flow to trigger
- **Payload** — the JSON to pass to the other flow's `$trigger`
- **Iteration Mode** — when the payload is an array: `parallel` (default; runs all in parallel), `serial` (runs one after another), or `batch` (runs in batches)
- **Batch Size** — the batch size when Iteration Mode is `batch` (defaults to 10)

Appends the other flow's response, when one is configured. If the other flow has no Response Body, this operation appends `null`.

If the payload is an array, the other flow runs once per array item using the configured iteration mode.

## Sleep

Pauses the flow for a configured number of milliseconds.

- **Milliseconds** — how long to sleep

Appends `null`. Use sparingly; long sleeps tie up flow workers.

## Transform Payload

Builds a custom JSON object that subsequent operations can reference.

- **JSON** — the object to build, with [data chain variables](/docs/guides/automate/#data-chain-variables) for dynamic values

Appends the resulting object.

This operation is useful for stitching together values from earlier operations into a single shape, such as preparing the body of a webhook request or the payload for a Create Data operation.

## Log to Console

Writes a message to the server-side console and to the flow's logs.

- **Message** — the message to log

Appends `null`. The message itself is visible only in the flow's logs and in the server output, not in the data chain.

This is the primary debugging tool for flows.
