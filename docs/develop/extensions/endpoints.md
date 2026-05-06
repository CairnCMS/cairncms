---
title: Endpoint extensions
description: Custom HTTP endpoints registered with the API.
---

An endpoint extension adds custom HTTP routes to the CairnCMS API. Reach for one when you need behavior that does not map to a collection's CRUD endpoints, for example, a complex aggregation, a third-party integration, a webhook receiver that doesn't fit the flow trigger model, or a custom business operation that should be exposed as a single REST call.

An endpoint extension is a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/). It runs server-side in the same Node process as the rest of the API, with full access to the platform's services and database connection.

## Anatomy

An endpoint extension exports either a function or an object. Both forms register one or more routes on an Express router.

### Function form

The simplest form is a function that takes the router and a context object:

```js
export default (router) => {
  router.get('/', (req, res) => res.send('Hello, World!'));
};
```

When you use the function form, the extension's package name becomes the mount path. A package named `cairncms-extension-greet` mounts at `/greet`.

### Object form

To set the mount path explicitly, export an object with `id` and `handler`:

```js
import { defineEndpoint } from '@cairncms/extensions-sdk';

export default defineEndpoint({
  id: 'greet',
  handler: (router) => {
    router.get('/', (req, res) => res.send('Hello, World!'));
    router.get('/intro', (req, res) => res.send('Nice to meet you.'));
    router.get('/goodbye', (req, res) => res.send('Goodbye!'));
  },
});
```

These routes are accessible at `/greet`, `/greet/intro`, and `/greet/goodbye`.

`defineEndpoint` is a no-op type wrapper; it returns the config unchanged but gives you full TypeScript inference on the shape.

## The router

The first argument is an Express router scoped to the extension's mount path. Use the standard Express verbs (`get`, `post`, `patch`, `put`, `delete`) and middleware patterns:

```js
export default (router) => {
  router.use((req, res, next) => {
    // middleware applied to all routes in this extension
    next();
  });

  router.get('/items', (req, res, next) => {
    res.json({ items: [] });
  });

  router.post('/items', express.json(), (req, res, next) => {
    res.status(201).json({ created: true });
  });
};
```

The router is mounted at the app root underneath the API's main middleware stack. Authentication, rate limiting, and the schema middleware all run before your handler does, so `req.accountability` and `req.schema` are populated by the time your code runs.

## The context

The second argument is a context object with everything an endpoint typically needs:

- **`services`** — all built-in services (`ItemsService`, `FilesService`, `UsersService`, `MailService`, and so on). Use these for any data work you want to respect permissions and validation.
- **`exceptions`** — the platform's exception classes. Throw these to surface proper HTTP error responses; pass to `next(err)` from inside async route handlers.
- **`database`** — a [Knex](https://knexjs.org/) instance connected to the configured database. Use this only when a service does not cover what you need.
- **`getSchema`** — async function that returns the current schema overview. Used when constructing a service outside a request context.
- **`env`** — the parsed environment variables.
- **`logger`** — a Pino logger instance. Use this rather than `console.log` so messages flow through the platform's logging pipeline.
- **`emitter`** — the platform's event emitter. Use this to fire custom events that other extensions can subscribe to with hooks.

```js
export default (router, { services, exceptions }) => {
  const { ItemsService } = services;
  const { ServiceUnavailableException } = exceptions;

  router.get('/popular-recipes', async (req, res, next) => {
    try {
      const recipes = new ItemsService('recipes', {
        schema: req.schema,
        accountability: req.accountability,
      });

      const results = await recipes.readByQuery({
        sort: ['-views'],
        limit: 10,
        fields: ['id', 'title', 'views'],
      });

      res.json(results);
    } catch (error) {
      next(new ServiceUnavailableException(error.message));
    }
  });
};
```

When you use the `emitter`, never emit an event that you (or another extension) are listening to from this same path. That creates an infinite loop with the same operational outcome as `while (true)`.

## Permissions and accountability

Each request carries an `accountability` object that describes the caller, including the user, role, IP, admin status, app status, and so on. Pass it through to any service you instantiate:

```js
const items = new ItemsService('articles', {
  schema: req.schema,
  accountability: req.accountability,
});
```

The service then applies the caller's permissions to every read and write. A reader limited by a custom-permissions filter rule sees only the items they are allowed to see, automatically.

To bypass permissions for an admin-only operation, omit `accountability` entirely:

```js
const items = new ItemsService('articles', {
  schema: req.schema,
});
```

This is equivalent to running as an admin. Reserve it for trusted endpoints; never use it on a route that takes user input that influences which records are touched.

## Errors

The platform's exception classes turn into proper HTTP status codes when passed to `next()`:

- `InvalidPayloadException` → 400
- `ForbiddenException` → 403
- `RouteNotFoundException` → 404
- `MethodNotAllowedException` → 405
- `ServiceUnavailableException` → 503

```js
const { InvalidPayloadException } = exceptions;

router.post('/work', async (req, res, next) => {
  if (!req.body.payload) {
    return next(new InvalidPayloadException('payload is required'));
  }
  // ...
});
```

Wrap async handler bodies in `try/catch` and pass errors to `next(err)` so they reach the error middleware consistently. Express 4's behavior around unhandled async throws in raw route handlers is uneven without a wrapper, so making the path through `next()` explicit is the most reliable pattern here.

## A complete minimal example

An endpoint that exposes a count of published articles per author. Useful illustration of services + accountability + exceptions in one place.

`src/index.js`:

```js
import { defineEndpoint } from '@cairncms/extensions-sdk';

export default defineEndpoint({
  id: 'article-stats',
  handler: (router, { services, exceptions }) => {
    const { ItemsService } = services;
    const { ServiceUnavailableException } = exceptions;

    router.get('/by-author', async (req, res, next) => {
      try {
        const articles = new ItemsService('articles', {
          schema: req.schema,
          accountability: req.accountability,
        });

        const results = await articles.readByQuery({
          aggregate: { count: '*' },
          groupBy: ['author'],
          filter: { status: { _eq: 'published' } },
        });

        res.json(results);
      } catch (error) {
        next(new ServiceUnavailableException(error.message));
      }
    });
  },
});
```

After build and install, the endpoint is reachable at `GET /article-stats/by-author`. Permissions on the `articles` collection are applied automatically because the service was constructed with the request's `accountability`.

## Where to go next

- [Hooks](/docs/develop/extensions/hooks/) cover server-side reactions to platform events. Use a hook when you need to react to a built-in operation rather than expose a new HTTP route.
- [Operations](/docs/develop/extensions/operations/) cover custom flow operations. Use an operation when the work belongs inside a flow.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full.
