---
title: Webhooks
description: How webhooks work in CairnCMS, configured as flows in both directions.
sidebar:
  order: 3
---

CairnCMS handles webhooks through flows, in both directions. There is no separate webhooks collection or settings page; both inbound and outbound HTTP run through the flow chain. The legacy Settings > Webhooks feature was removed in v1.0.

## Incoming webhooks

Expose an HTTP endpoint that an external service can call to run logic in CairnCMS. Configure a flow with the **Webhook** trigger. The trigger panel shows the flow-specific URL once the flow is saved; that URL is unauthenticated, so treat it as a credential.

See [Triggers](/docs/guides/automate/triggers/#webhook) for the trigger options, the URL location, and the asynchronous / synchronous response shape.

## Outgoing webhooks

Send an HTTP request to a downstream service when something happens in CairnCMS. Configure a flow with an **Event hook** trigger (or any trigger that fits the source event) plus a **Webhook / Request URL** operation.

See [Operations](/docs/guides/automate/operations/#webhook--request-url) for the operation options. The flow can also include a Condition operation to filter which events actually call the URL, a Transform Payload operation to reshape the request body, or multiple Webhook / Request URL operations to fan out.

## Security

Incoming webhook URLs are unauthenticated by default. Anyone with the URL can call the flow. Treat the request body and headers as untrusted input. Validate them before reading or writing data based on their contents.

If the calling service supports signed requests (HMAC, JWT, or shared-secret headers), verify the signature in a Run Script or Condition operation before any side-effecting operations run. Rotate or reissue the URL if it leaks.
