---
title: Triggers
description: How flows start, including events, schedules, manual button clicks, and incoming webhooks.
---

A trigger defines when a flow runs. CairnCMS supports five trigger types: Event hook, Webhook, Schedule, Another flow, and Manual. Each has different semantics around when it fires, what payload it provides, and whether it can modify the original event.

Every trigger appends its data into the `$trigger` key of the [data chain](/docs/guides/automate/#the-data-chain).

## Event hook

Event hooks fire on platform events: item created, item updated, item deleted, user logged in, and so on. There are two subtypes that differ in whether they can modify the event:

- **Filter (blocking)** — pauses the event, runs the flow, and optionally replaces the event payload before allowing the event to commit. Use this when the flow needs to validate, transform, or veto the action.
- **Action (non-blocking)** — lets the event commit immediately and runs the flow afterward. The flow has access to the event payload but cannot change or cancel the event.

Configuration:

- **Type** — Filter or Action
- **Scope** — which event types fire the trigger (`items.create`, `items.update`, `users.login`, and so on)
- **Collections** — which collections the trigger applies to, when relevant
- **Response Body** — for Filter triggers only; defines what replaces the event payload (the value of `$last`, the entire data chain, or a specific operation key)

When a request creates multiple items in one call, an event hook fires once per item, with one item in each `$trigger.payload`.

To cancel a transaction from a Filter trigger, throw an error in a Run Script operation or end the flow on a failure path.

## Webhook

Webhook triggers expose an HTTP endpoint at a flow-specific URL. External services call that URL, and the flow runs in response.

Configuration:

- **Method** — GET or POST
- **Asynchronous** — if enabled, the trigger responds immediately and the flow runs in the background. If disabled, the flow runs to completion before responding.
- **Response Body** — what to return when not asynchronous (the value of `$last`, the entire data chain, or a specific operation key)

The full URL appears in the trigger panel after the flow is saved. Treat this URL as private; anyone with it can invoke the flow.

For the broader pattern, see the [Webhooks](/docs/guides/automate/webhooks/) page.

## Schedule (cron)

Schedule triggers fire on a cron schedule.

Configuration:

- **Interval** — a 6-point cron expression

The 6-point cron syntax is:

```
 ┌────────────── second (0-59)
 │ ┌──────────── minute (0-59)
 │ │ ┌────────── hour (0-23)
 │ │ │ ┌──────── day of month (1-31)
 │ │ │ │ ┌────── month (1-12)
 │ │ │ │ │ ┌──── day of week (0-7)
 * * * * * *
```

Common patterns include `0 0 * * * *` (every hour on the hour), `0 0 0 * * *` (every day at midnight), and `0 0 0 * * 0` (every Sunday at midnight).

There is no `$trigger.payload` for schedule-based runs.

## Another flow

This trigger fires when a **Trigger Flow** operation in another flow runs against this flow. It is the entry point for chained flows.

Configuration:

- **Response Body** — what to return to the calling flow (the value of `$last`, the entire data chain, or a specific operation key)

If the calling flow passes an array as its payload, this flow runs once per array item.

## Manual

Manual triggers add a button to one or more collection or item pages. Clicking the button runs the flow. The button appears in a Flows section in the page sidebar.

Configuration:

- **Collections** — which collections show the button
- **Location** — collection page, item page, or both
- **Asynchronous** — whether the user can re-trigger before the flow finishes
- **Collection Page (Requires Selection)** — whether the user must select items before the button is enabled
- **Require Confirmation** — whether a confirmation dialog appears before the flow runs

The trigger receives the HTTP request data as `$trigger`. The manual run details are inside `$trigger.body`:

- `$trigger.body.collection` — the collection the button was triggered from
- `$trigger.body.keys` — an array of item IDs, when present. On an item page, this contains the current item's ID. On a collection page, it contains the user's selection.

When **Collection Page (Requires Selection)** is disabled, a collection-page flow can run with no selected items; in that case `$trigger.body.keys` is absent and only `$trigger.body.collection` is set.

When confirmation is required, the user-provided input values are merged into `$trigger.body` alongside `keys` and `collection`.

After the flow runs, a toast notification appears in the sidebar showing whether it succeeded.
