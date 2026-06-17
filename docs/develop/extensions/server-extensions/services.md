---
title: Internal services
description: The platform services available to full-authority server extensions.
sidebar:
  label: Services
  order: 10
---

A full-authority server extension (a hook, endpoint, or operation with no `runtime`) receives a `context` object carrying the platform's internal services. They are the same services the API uses, so working through them respects permissions, validation, and the event pipeline rather than going straight to the database.

This page is the full-authority path. A confined extension does not get raw services. It reads through `host.items` instead. See the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) reference.

## Reaching the services

The services arrive on the handler context, alongside `getSchema`:

```js
export default (router, { services, getSchema }) => {
  router.get('/recent', async (req, res) => {
    const { ItemsService } = services;

    const articles = new ItemsService('articles', {
      schema: await getSchema(),
      accountability: req.accountability,
    });

    res.json(await articles.readByQuery({ sort: ['-date_created'], limit: 10 }));
  });
};
```

Most service constructors take an options object with a `schema` (from `getSchema()`) and an optional `accountability`. `ItemsService` also takes the collection name as its first argument. A few are specialized: `SchemaService`, for example, takes no `schema`. Check the service class when in doubt.

## Accountability and permissions

The `accountability` you pass decides whose permissions apply.

- **Pass the request or trigger accountability** (`req.accountability` in an endpoint, the trigger's `accountability` in an operation or hook) to run as that user. Permissions, validation, and field access all apply as they would on a normal API call.
- **Omit `accountability` or pass `null`** to bypass permission checks entirely. The service then runs with system authority. Use this deliberately, only for work that must run regardless of any user, and never with caller-supplied input that should have been permission-checked.

## ItemsService

`ItemsService` is the one you reach for most. It is CRUD over a collection's items: `createOne`, `createMany`, `readOne`, `readMany`, `readByQuery`, `updateOne`, `updateMany`, `updateByQuery`, `upsertOne`, `upsertMany`, `deleteOne`, `deleteMany`, and `deleteByQuery`. The read methods accept a query object the same shape the REST API uses (`fields`, `filter`, `sort`, `limit`, and so on).

When a handler writes through `ItemsService` to a collection whose own event it is handling, pass `{ emitEvents: false }` to the write so it does not trigger itself recursively.

## The other services

The same `services` object exposes the rest of the platform's service layer, constructed the same way. The common ones:

- **`CollectionsService`** — create, read, update, and delete collections.
- **`FieldsService`** — manage fields on a collection.
- **`RelationsService`** — manage relations between collections.
- **`FilesService`** — import and upload files (`importOne`, `uploadOne`), plus the standard item methods.
- **`UsersService`** — manage users.

The registry holds more (activity, notifications, revisions, settings, shares, and so on). The `services` object is the current catalog. Construct most of them with `{ schema, accountability }`, and check the class for the specialized ones.

## Where to go next

- [Hooks](/docs/develop/extensions/server-extensions/hooks/), [Endpoints](/docs/develop/extensions/server-extensions/endpoints/), and [Operations](/docs/develop/extensions/server-extensions/operations/) show the services in their handler context.
- [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) covers the confined alternative, `host.items`.
