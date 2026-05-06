---
title: Webhooks
description: Trigger outgoing HTTP requests on data events and receive incoming HTTP requests through flows.
sidebar:
  order: 3
---

CairnCMS supports webhooks in both directions:

- **Outgoing webhooks** — send an HTTP request to a downstream service when something happens in CairnCMS, such as an item being created, updated, or deleted, or a user logging in
- **Incoming webhooks** — expose an HTTP endpoint that an external service can call to run logic in CairnCMS

Outgoing webhooks should be configured as flows. CairnCMS also still ships the legacy **Settings > Webhooks** page from earlier Directus versions, but it is **planned for deprecation** and lacks capabilities flows have, most notably run-by-run logging. Use it only if you have an existing setup that relies on it; for new work, build a flow.

Incoming webhooks are configured as flows with the **Webhook** trigger.

## Outgoing webhooks via flows

To send an HTTP request when an event happens:

1. Create a flow under **Settings > Flows**.
2. Set the trigger to **Event hook (Action)**, scoped to the events and collections you want to react to.
3. Add a **Webhook / Request URL** operation. Configure the method, URL, headers, and request body.

The request body can include data chain variables (for example, `{{ $trigger.payload.id }}`) to inject values from the event.

The flow approach lets you:

- add a **Condition** operation to filter which events actually call the URL
- add a **Transform Payload** operation to reshape the data before sending
- add multiple Webhook / Request URL operations to fan out to several endpoints
- chain follow-up operations after the request completes
- inspect each run through the flow's logs

Use Action triggers (non-blocking) when the request is not essential to the original event. Filter triggers (blocking) keep the event paused until the flow finishes; for outgoing webhooks that hit a slow or unreliable external service, that pause is usually undesirable.

## Legacy Settings > Webhooks

The **Settings > Webhooks** page predates flows. It is **planned for deprecation** and is missing capabilities the flow approach has, most notably run-by-run logging. Existing webhook records continue to function for now, but new work should be built as a flow.

The page exposes:

- **Name** — a label
- **Method** — GET or POST
- **URL** — the target URL
- **Status** — Active or Inactive
- **Data** — whether to include the event payload in the request body
- **Request Headers** — custom headers
- **Trigger Actions** — which actions fire this webhook (create, update, delete, login)
- **Trigger Collections** — which collections this webhook applies to

Each field maps directly to part of the equivalent flow: Method, URL, Headers, and Data correspond to the Webhook / Request URL operation; Trigger Actions and Trigger Collections correspond to the Event hook trigger's Scope and Collections. Migrating an existing record is a matter of recreating it as a flow with those mappings.

## Incoming webhooks

Expose an HTTP endpoint that an external service can call to run logic in CairnCMS.

1. Create a flow under **Settings > Flows**.
2. Set the trigger to **Webhook**.
3. Choose GET or POST and decide whether the response should be asynchronous.
4. Save the flow. The trigger panel shows the webhook URL once the flow is saved.
5. Copy that URL into the external service that will call it.
6. Add operations to the flow to process the incoming request. The request body and headers appear under `$trigger`.
7. If the calling service expects a response, configure a Response Body on the trigger.

Common uses:

- receive callbacks from payment providers, build pipelines, or third-party APIs
- accept form submissions from a frontend that does not authenticate against CairnCMS
- receive manually-triggered events from a script or another internal tool

## Security

Treat the request body and headers as untrusted input. Validate them before reading or writing data based on their contents. The webhook URL is unauthenticated by default — anyone with the URL can call the flow. Rotate or reissue the URL if it leaks.

If the calling service supports signed requests (HMAC, JWT, or shared-secret headers), verify the signature in a Run Script or Condition operation before any side-effecting operations run.

## Where to go next

- [Triggers](/docs/guides/automate/triggers/) covers the Event hook and Webhook trigger configurations in full.
- [Operations](/docs/guides/automate/operations/) covers the Webhook / Request URL operation and the surrounding ones (Condition, Transform Payload, Run Script).
