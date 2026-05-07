---
title: Quickstart
description: Create a local CairnCMS project, sign in, model a collection, and make your first API request.
sidebar:
  order: 2
---

Use this guide to run CairnCMS locally, create a simple collection, add one record, and fetch it through the API.

This quickstart uses the `cairncms init` scaffold. It is the fastest way to get a working local instance with Docker Compose, a generated `.env`, and an admin account.

This guide is for local development. It is not a production deployment guide.

## Requirements

Before you start, make sure you have:

- Docker with Compose v2
- Node 22 or newer if you want to use the generated `npm start`, `npm stop`, and `npm logs` shortcuts

## Create a local project

Run the init command:

```bash
npx cairncms init my-cms
```

This command:

- creates a new `my-cms/` directory
- writes the Docker Compose files into `my-cms/cairncms/`
- generates random secrets and an admin password in `my-cms/cairncms/.env`
- starts the stack by default

When the command finishes, it prints:

- the local URL, usually `http://localhost:8055`
- the admin email, which defaults to `admin@example.com`
- the generated admin password

If you only want the files and do not want to start the stack yet, use:

```bash
npx cairncms init my-cms --no-start
```

## Sign in to the app

Open the local URL in your browser:

```text
http://localhost:8055
```

Sign in with:

- Email: `admin@example.com`
- Password: the password printed by `cairncms init`

If you lose the password, you can read it from `my-cms/cairncms/.env`.

## Create a collection

Create a simple collection called `articles`.

1. Open **Settings > Data Model**.
2. Create a new collection.
3. Set the collection name to `articles`.
4. Keep the default options for now and save it.

At this point, CairnCMS has created the underlying database table for the collection.

## Add a field

Add a text field called `title`.

1. Stay in **Settings > Data Model** and open the `articles` collection.
2. Create a new field.
3. Use `title` as the field key.
4. Keep the default string input settings and save.

## Create a record

Now add one record through the app.

1. Switch to the **Content** module.
2. Open the `articles` collection.
3. Create a new record.
4. Set `title` to `Hello World`.
5. Save the record.

You now have content in the database and a collection the API can query.

## Allow temporary public read access

By default, new content is not public. For the quickest first API request, grant the built-in Public role read access to the `articles` collection.

1. Open **Settings > Roles & Permissions**.
2. Open the **Public** role.
3. Find the `articles` collection.
4. Allow **read** access for that collection.
5. Save the change.

## Make your first API request

Now open the collection endpoint directly in your browser:

```text
http://localhost:8055/items/articles
```

You can also request it with `curl`:

```bash
curl -sS http://localhost:8055/items/articles
```

You'll get a JSON response like this:

```json
{
  "data": [
    {
      "id": 1,
      "title": "Hello World"
    }
  ]
}
```

## Revoke public access

The public read permission in this guide is only there to make the first API request easy to verify.

When you are done testing it:

1. Go back to **Settings > Roles & Permissions > Public**.
2. Remove the `read` permission from `articles`.
3. Save the change.

## What you have now

At this point you have:

- a local CairnCMS instance running in Docker
- a collection backed by a real SQL table
- one saved record
- a working API request against a real collection

## Stop and restart the stack

From the project directory:

```bash
npm stop
npm start
```

If you prefer not to use the npm shortcuts, run Docker Compose directly:

```bash
docker compose --project-directory cairncms -f cairncms/docker-compose.yml up -d
docker compose --project-directory cairncms -f cairncms/docker-compose.yml down
```

## Next steps

Once the quickstart works, the next useful areas are:

- the app itself: create more collections, fields, and relationships
- permissions: decide what should be public and what should stay authenticated
- authentication: for real applications, authenticate requests with a token instead of exposing collections through the Public role
- the API: try schema and config snapshots in `my-cms/README.md`
- deployment: move on to the deployment docs when you are ready for a non-local setup
