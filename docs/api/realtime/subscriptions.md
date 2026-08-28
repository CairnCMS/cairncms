---
title: Subscription authorization
description: Permission-checked delivery, delete-feed eligibility, and ordering for realtime subscriptions.
sidebar:
  label: Subscriptions
  order: 2
---

This page covers authorization and ordering rules shared by the item protocol and GraphQL subscriptions. See the [item protocol](/docs/api/realtime/item-protocol/) and [GraphQL subscriptions](/docs/api/realtime/graphql/) for registration, event filters, selections, supported collections, and message shapes.

## Permission-checked delivery

Authorization is enforced when payloads are read, not at registration. An initial snapshot and every delivered create and update payload is read under the connection's current permissions, so a connection only ever receives item data it is allowed to read. The delete feed is the exception: it has no readable payload, so it is gated by a registration eligibility check instead (see below).

This is row-level. A role whose read permission carries a row filter (for example a tenant filter, or `owner` equal to `$CURRENT_USER`) receives changes only for the rows that match, and never sees another tenant's or another user's items, on either transport. Delivery re-evaluates the filter against each changed item, so a row that moves out of a subscriber's scope stops being delivered to it, and a row that moves into scope starts.

## The delete feed

Delete notifications are handled differently from create and update, because a deleted item can no longer be read.

For create and update, the delivered payload is the changed item read through the normal permission and query pipeline, so it reflects the subscriber's field selection and row-level access. A deleted item cannot be read back, so none of that per-item processing can run. The delete feed therefore has stricter rules and a different shape:

- **Explicit event.** A delete is delivered only to a subscription that sets `event: delete`. It is never included in an event-unset or a create/update subscription.
- **Eligibility.** The subscriber must have an unconditional read permission on the collection: a read permission with no row filter, whose fields include the primary key (or `*`). A role whose read permission carries a row filter is not eligible for the delete feed, because the filter cannot be evaluated against an item that no longer exists. Admin is always eligible.
- **Query-free.** A delete subscription cannot carry a query.
- **Payload.** The delete message carries the deleted primary keys, not item data. On the item protocol the payload is a key array (`data: [keys]`). On GraphQL it is `{ event: 'delete', key, data: null }`.

An ineligible delete subscription is rejected at registration: the item protocol returns the error code `DELETE_FEED_FORBIDDEN`, and GraphQL returns a `FORBIDDEN` error.

The `items.query` and `items.read` filter hooks do not apply to the delete feed. Eligibility is decided by the read permission above, and a delivered delete carries keys without running those hooks. An operator who relies on `items.query` or `items.read` to restrict read access must express the same restriction in roles and permissions, because the delete feed does not honor those hooks.

## Ordering

Change events for a single collection are dispatched in order, so a subscriber sees that collection's changes in the order they occurred. There is no cross-collection ordering guarantee.

## Where to go next

- [Item protocol](/docs/api/realtime/item-protocol/) — subscription frames, filters, snapshots, and item operations.
- [GraphQL subscriptions](/docs/api/realtime/graphql/) — subscription fields, selections, delete events, and close codes.
- [Reliability](/docs/api/realtime/reliability/) — multiple instances, resource limits, reverse proxies, and recovery.
