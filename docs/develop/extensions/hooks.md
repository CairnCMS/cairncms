---
title: Hook extensions
description: Filter, action, init, schedule, and embed hooks for extending the API event lifecycle.
sidebar:
  order: 7
---

A hook extension lets server-side code react to events in the platform, such as items being created, users logging in, the server starting up, scheduled times being reached, and so on. Hooks are the primary way to add logic that runs alongside CairnCMS's built-in operations rather than replacing them.

A hook extension is a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/). It runs server-side in the same Node process as the rest of the API, with full access to the platform's services and database connection.

## Anatomy

A hook extension exports a function that registers one or more event handlers:

```js
import { defineHook } from '@cairncms/extensions-sdk';

export default defineHook(({ filter, action }) => {
  filter('items.create', () => {
    console.log('Creating item!');
  });

  action('items.create', () => {
    console.log('Item created!');
  });
});
```

The function receives a `register` object with five typed register functions and a `context` object identical to the one passed to endpoint extensions.

`defineHook` is a no-op type wrapper; it returns the config unchanged but gives you full TypeScript inference on the shape.

## Hook types

There are five hook types. Each runs at a different point and receives different arguments:

- **Filter** — runs *before* an event commits. Can transform the payload or veto the event.
- **Action** — runs *after* an event commits. Cannot change the outcome.
- **Init** — runs once at specific lifecycle points (server startup, route registration, and so on).
- **Schedule** — runs on a cron schedule, independent of any platform event.
- **Embed** — injects custom HTML, CSS, or JavaScript into the admin app's `<head>` or `<body>`.

Choose Filter when you need to validate, transform, or block. Choose Action for fire-and-forget work that should not delay the response.

## Filter hooks

Filter hooks pause an event, hand the payload to the handler, and continue with whatever the handler returns. Throw to cancel the event entirely.

```js
export default defineHook(({ filter }, { exceptions }) => {
  const { InvalidPayloadException } = exceptions;

  filter('items.create', async (input, { collection }, { schema, accountability }) => {
    if (collection !== 'articles') return input;

    if (!input.title) {
      throw new InvalidPayloadException('Articles require a title.');
    }

    input.slug = input.title.toLowerCase().replace(/\s+/g, '-');
    return input;
  });
});
```

The filter callback receives three arguments:

- **`payload`** — the data the platform is about to act on. Return it (modified or unchanged) to continue. Throw to cancel.
- **`meta`** — an event-specific object describing what is happening (collection name, item keys, query, and so on).
- **`context`** — `{ database, schema, accountability }` for the current request.

Filters are blocking. They run inline with the request and add to its latency. Be conservative inside `read`-event filters, since a single API call can produce many read events, and a slow filter compounds quickly.

## Action hooks

Action hooks fire after the event commits. The original operation has already happened by the time your handler runs; throwing does not roll anything back.

```js
export default defineHook(({ action }, { services, getSchema }) => {
  const { MailService } = services;

  action('items.create', async (meta, { schema, database, accountability }) => {
    if (meta.collection !== 'orders') return;

    const mail = new MailService({ schema, knex: database, accountability });
    await mail.send({
      to: 'fulfillment@example.com',
      subject: 'New order',
      template: { name: 'new-order', data: { order: meta.payload } },
    });
  });
});
```

The action callback receives two arguments:

- **`meta`** — the event-specific object, including the payload and any keys involved.
- **`context`** — `{ database, schema, accountability }` for the request that triggered the event.

Use actions for side effects that should run alongside the operation but should not slow it down or have the power to cancel it.

## Init hooks

Init hooks run at specific lifecycle points during platform startup, not in response to user events. Use them when you need to inject middleware, register custom routes, or configure third-party libraries that need to run before requests start flowing.

```js
export default defineHook(({ init }) => {
  init('app.before', ({ app }) => {
    app.use((req, res, next) => {
      req.startedAt = Date.now();
      next();
    });
  });
});
```

The init callback receives a single `meta` argument whose shape depends on the event. The available init events all carry an `app` reference, except for `cli.before` and `cli.after` which carry the CLI `program`.

## Schedule hooks

Schedule hooks run on a cron schedule. They are powered by [`node-cron`](https://www.npmjs.com/package/node-cron) and accept a standard 5-position cron expression.

```js
import axios from 'axios';

export default defineHook(({ schedule }) => {
  schedule('*/15 * * * *', async () => {
    await axios.post('https://example.com/heartbeat', { ts: new Date() });
  });
});
```

Cron expressions:

- `*/15 * * * *` — every 15 minutes
- `15 14 1 * *` — at 14:15 on day-of-month 1
- `5 4 * * sun` — at 04:05 on Sunday

The schedule register function takes the cron expression as the first argument and the handler as the second. The handler receives no arguments.

Schedule hooks run whenever the extension manager is initialized with `schedule: true`, which is the default. The API server uses the default, so schedule hooks run there. The CLI explicitly opts out (`{ schedule: false, watch: false }`), so commands like database migrations and schema snapshots do not trip schedule handlers.

## Embed hooks

Embed hooks inject HTML into the admin app's `<head>` or `<body>` which are useful for adding analytics tags, error monitoring, or stylesheet overrides.

```js
export default defineHook(({ embed }, { env }) => {
  embed('head', () => `
    <script>
      window.gtmId = '${env.GTM_ID}';
    </script>
  `);

  embed(
    'body',
    '<script src="https://cdn.example.com/widget.js" async></script>'
  );
});
```

The embed register function takes:

- **`position`** — either `'head'` or `'body'`
- **`code`** — a string of HTML or a function returning one. The function form lets you read environment variables or other context at registration time.

Empty strings are ignored with a warning logged.

## The context

The context object passed as the second argument to the registration function has everything a hook typically needs:

- **`services`** — all built-in services (`ItemsService`, `MailService`, `UsersService`, and so on)
- **`exceptions`** — the platform's exception classes
- **`database`** — a Knex instance connected to the configured database
- **`getSchema`** — async function that returns the current schema overview
- **`env`** — parsed environment variables
- **`logger`** — a Pino logger instance
- **`emitter`** — the platform's event emitter, for firing custom events that other hooks can listen for

When you use the emitter, never emit an event that your own hook handles. Direct or indirect self-emission produces an infinite loop with no useful exit.

The handler-level context (the third argument to filter callbacks, the second to action callbacks) is different from this top-level context. The handler context contains `database`, `schema`, and `accountability` for the *current request*. The top-level context contains *platform-wide* services and helpers. Use the handler context for permission-aware data work; use the top-level context for everything else.

## Event reference

CairnCMS events follow a `<type>.<event>` or `<collection>.items.<event>` naming pattern.

### Filter events

| Event | Payload | Meta |
|---|---|---|
| `request.not_found` | `false` | `request`, `response` |
| `request.error` | the request error | — |
| `database.error` | the database error | `client` |
| `auth.login` | the login payload | `status`, `user`, `provider` |
| `auth.jwt` | the auth token | `status`, `user`, `provider`, `type` |
| `authenticate` | the empty accountability object | `req` |
| `(<collection>.)items.query` | the items query | `collection` |
| `(<collection>.)items.read` | the read item | `query`, `collection` |
| `(<collection>.)items.create` | the new item | `collection` |
| `(<collection>.)items.update` | the updated item | `keys`, `collection` |
| `(<collection>.)items.delete` | the keys of the item | `collection` |
| `<system-collection>.create` | the new item | `collection` |
| `<system-collection>.update` | the updated item | `keys`, `collection` |
| `<system-collection>.delete` | the keys of the item | `collection` |

### Action events

| Event | Meta |
|---|---|
| `server.start` | `server` |
| `server.stop` | `server` |
| `response` | `request`, `response`, `ip`, `duration`, `finished` |
| `auth.login` | `payload`, `status`, `user`, `provider` |
| `files.upload` | `payload`, `key`, `collection` |
| `(<collection>.)items.read` | `payload`, `query`, `collection` |
| `(<collection>.)items.create` | `payload`, `key`, `collection` |
| `(<collection>.)items.update` | `payload`, `keys`, `collection` |
| `(<collection>.)items.delete` | `keys`, `collection` |
| `(<collection>.)items.sort` | `collection`, `item`, `to` |
| `<system-collection>.create` | `payload`, `key`, `collection` |
| `<system-collection>.update` | `payload`, `keys`, `collection` |
| `<system-collection>.delete` | `keys`, `collection` |

### Init events

| Event | Meta |
|---|---|
| `cli.before` | `program` |
| `cli.after` | `program` |
| `app.before` | `app` |
| `app.after` | `app` |
| `routes.before` | `app` |
| `routes.after` | `app` |
| `routes.custom.before` | `app` |
| `routes.custom.after` | `app` |
| `middlewares.before` | `app` |
| `middlewares.after` | `app` |

### System collection names

Where the table above shows `<system-collection>`, replace it with one of: `activity`, `collections`, `dashboards`, `fields`, `files` (except create/update), `flows`, `folders`, `notifications`, `operations`, `panels`, `permissions`, `presets`, `relations`, `revisions`, `roles`, `settings`, `shares`, `users`.

The `directus_` prefix is stripped from event names, so a handler that registers `users.create` fires whenever a user is created,  regardless of which API path triggered the create. Use the unprefixed form, not `directus_users.create`.

## A complete minimal example

A hook that auto-generates a slug for new articles.

`src/index.js`:

```js
import { defineHook } from '@cairncms/extensions-sdk';

export default defineHook(({ filter }) => {
  filter('items.create', async (input, { collection }) => {
    if (collection !== 'articles') return input;
    if (input.slug || !input.title) return input;

    input.slug = String(input.title)
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    return input;
  });
});
```

After build and install, this filter fires whenever an article is created (through the API, the app, or a flow), generating a slug if the editor did not supply one. Returning the modified `input` is what causes the platform to continue with the new value.

## Where to go next

- [Endpoints](/docs/develop/extensions/endpoints/) cover custom HTTP routes when you need to expose a new API surface rather than react to existing ones.
- [Operations](/docs/develop/extensions/operations/) cover custom flow operations when the work belongs inside a configurable, user-built flow.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full.
