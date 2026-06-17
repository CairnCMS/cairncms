---
title: Composables
description: The Vue composables the SDK provides for app extensions.
sidebar:
  label: Composables
  order: 7
---

App extensions are Vue components, and the SDK ships a set of composables for what an extension commonly needs: calling the API as the current user, reading collection metadata, fetching items, and reaching the admin app's stores. Import them from `@cairncms/extensions-sdk`.

## useApi

```ts
import { useApi } from '@cairncms/extensions-sdk';

const api = useApi();
const response = await api.get('/items/articles');
```

`useApi()` returns an Axios instance wired to the admin app's session. Requests carry the logged-in user's credentials and go to the same API the app uses, so an app extension reads and writes exactly what the current user is permitted to. This is the primary way an app extension talks to the API.

## useStores

```ts
import { useStores } from '@cairncms/extensions-sdk';

const { useCollectionsStore, useFieldsStore, usePermissionsStore } = useStores();
const collections = useCollectionsStore();
```

`useStores()` returns the admin app's Pinia store accessors. Use them for app state that is not a plain API call: the collections and fields stores for schema metadata, the permissions store to check the current user's access, and the others the app exposes. Each accessor is a Pinia store hook.

## useCollection

```ts
import { useCollection } from '@cairncms/extensions-sdk';

const { info, fields, primaryKeyField } = useCollection('articles');
```

`useCollection(collection)` takes a collection name (a string or a ref) and returns reactive metadata about it: `info` (the collection record), `fields`, `defaults`, and `primaryKeyField`. Use it when a component needs a collection's shape without fetching its items.

## useItems

```ts
import { useItems } from '@cairncms/extensions-sdk';
import { ref } from 'vue';

const collection = ref('articles');
const query = {
  fields: ref(['id', 'title']),
  limit: ref(25),
  sort: ref(['title']),
  search: ref(null),
  filter: ref(null),
  page: ref(1),
};

const { items, totalCount, getItems } = useItems(collection, query);
await getItems();
```

`useItems(collection, query)` fetches items with pagination. It takes a collection ref and a query object whose `fields`, `limit`, `sort`, `search`, `filter`, and `page` are each their own ref, and returns the reactive `items`, `totalPages`, `itemCount`, and `totalCount`, plus `getItems()`, `getItemCount()`, and `getTotalCount()` to run or rerun the fetch. It is the composable layouts and panels build on.

## The rest

The SDK also re-exports:

- **`useSync`** — wraps a prop and its `update:` event into a writable computed, the standard way to make a prop two-way inside a component.
- **`useLayout`** — resolves a registered layout by id, used when one extension hosts another's layout.
- **`useFilterFields`** — derives the set of fields a filter applies to.
- **`useExtensions`** — returns the reactive registry of loaded app extensions.

Import any of them from `@cairncms/extensions-sdk`.

## Where to go next

- [App extensions](/docs/develop/extensions/app-extensions/) covers the browser lane and the runtime model.
- The individual type pages show these composables in context.
