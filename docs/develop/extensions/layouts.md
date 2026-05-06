---
title: Layout extensions
description: Custom collection page layouts for the admin app.
---

A layout controls how items in a collection are browsed in the app. CairnCMS ships built-in layouts (Tabular, Cards, Calendar, Map); a layout extension adds a new one.

A layout is the most structurally complex of the app extensions. It has four Vue components — a main component plus three slots — and a `setup` function that builds shared state for all of them. All five live inside a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/).

## Anatomy

The package's source entrypoint exports a configuration object built with `defineLayout`:

```js
import { ref } from 'vue';
import { defineLayout } from '@cairncms/extensions-sdk';
import LayoutComponent from './layout.vue';
import LayoutOptions from './options.vue';
import LayoutSidebar from './sidebar.vue';
import LayoutActions from './actions.vue';

export default defineLayout({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  component: LayoutComponent,
  slots: {
    options: LayoutOptions,
    sidebar: LayoutSidebar,
    actions: LayoutActions,
  },
  setup() {
    const name = ref('Custom Layout');
    return { name };
  },
});
```

`defineLayout` is generic in two type parameters, `Options` and `Query`, that describe the user-saved options shape and the layout-specific query parameters (sort, limit, page, fields, and so on). Use them to get full TypeScript inference inside the components:

```ts
import { defineLayout } from '@cairncms/extensions-sdk';
import type { LayoutOptions, LayoutQuery } from './types';

export default defineLayout<LayoutOptions, LayoutQuery>({
  // ...
});
```

## Configuration

The fields available on a layout configuration object:

- **`id`** — unique key. Scope proprietary layouts with an author or organization prefix.
- **`name`** — display name shown in the layout selector.
- **`icon`** — icon name from the Material icon set or one of CairnCMS's custom icons.
- **`component`** — the main Vue component, rendered in the page's content area.
- **`slots`** — an object with three Vue components that render alongside the main component:
  - **`options`** — appears in the **Layout Options** section of the page sidebar
  - **`sidebar`** — appears as additional sections in the page sidebar
  - **`actions`** — appears in the page header next to the standard action buttons
  - All three are required. Use `() => undefined` for any slot you do not need.
- **`setup`** — a function that builds shared state for all four components. Receives the standard layout props as the first argument and a context object (with `emit`) as the second. Returns an object whose properties are merged into every component's props.
- **`smallHeader`** — when `true`, the page header is rendered in a more compact style.
- **`headerShadow`** — when `false`, the drop shadow under the header is suppressed. Useful when the layout has its own header treatment.

## The setup function

`setup` is where layouts do most of their work. It runs once when the layout mounts and returns reactive state shared with all four components.

```js
setup(props, { emit }) {
  const selection = useSync(props, 'selection', emit);
  const layoutOptions = useSync(props, 'layoutOptions', emit);
  const layoutQuery = useSync(props, 'layoutQuery', emit);

  const { collection, filter, search } = toRefs(props);
  const { info, primaryKeyField } = useCollection(collection);
  const { items, loading, error, totalPages } = useItems(collection, /* query */);

  return { selection, layoutOptions, layoutQuery, items, loading, error };
}
```

Whatever `setup` returns is bound to all four components as props. Components that need shared state simply declare a matching `prop`.

The context argument exposes one method:

- **`emit(event, ...args)`** — emit one of `update:selection`, `update:layoutOptions`, or `update:layoutQuery` to write back to the parent. Use `useSync` to wrap this in a writable computed ref.

## Standard layout props

Every layout component receives the following props in addition to whatever `setup` returns:

- **`collection`** — the collection key currently being browsed (or `null` while loading)
- **`selection`** — array of currently-selected item primary keys
- **`layoutOptions`** — the user's saved options for this layout (typed as `Options` from the generic)
- **`layoutQuery`** — the user's layout query (sort, limit, fields, page; typed as `Query` from the generic)
- **`filter`** — combined active filter (user + system)
- **`filterUser`** — the user-applied filter
- **`filterSystem`** — system-applied filters (such as those from a preset or shared link)
- **`search`** — the current search string
- **`selectMode`** — whether the layout is in select mode (multi-select via long-press, for example)
- **`showSelect`** — whether selection is allowed: `'none'`, `'one'`, or `'multiple'`
- **`readonly`** — whether the layout should refuse mutations (during share-link viewing, for example)
- **`resetPreset`** — function that resets the user's saved preset for this layout
- **`clearFilters`** — function that clears the active filters

### Standard emits

The main component emits these events to update writable layout state. `setup` typically wraps each in `useSync`:

- **`update:selection`** — change the selected items
- **`update:layoutOptions`** — persist options changes
- **`update:layoutQuery`** — persist query changes

For values returned from `setup`, an `update:<key>` event is also available for two-way binding from the slot components.

## Layout composables

The SDK ships a few composables tailored to layout development:

- **`useSync(props, key, emit)`** — wraps a prop into a writable ref that emits `update:<key>` on write. Use this for `selection`, `layoutOptions`, and `layoutQuery` so child components can mutate them directly.
- **`useCollection(collectionRef)`** — returns reactive metadata for a collection: `info`, `fields`, `primaryKeyField`, `sortField`, and so on.
- **`useItems(collectionRef, query)`** — fetches items from the API with a reactive query. Returns `items`, `itemCount`, `totalCount`, `totalPages`, `loading`, `error`, and helpers like `changeManualSort`, `getItems`, `getTotalCount`.
- **`useFilterFields(fields, filter)`** — utilities for working with filterable field definitions.
- **`useLayout(layoutId)`** — takes a reactive layout ID and returns the wrapper component used to render that layout. This is framework plumbing for route-level rendering; rarely needed in extension code.

These come from `@cairncms/extensions-sdk` alongside the more general composables.

## Accessing internal systems

The SDK exports three composables for reaching internal systems from a layout component:

- **`useApi()`** — an axios instance pre-configured to talk to the CairnCMS API as the current user
- **`useStores()`** — the Pinia stores the app uses internally
- **`useExtensions()`** — the registered-extension catalog

```js
import { useApi, useStores } from '@cairncms/extensions-sdk';

export default {
  setup() {
    const api = useApi();
    const { useCollectionsStore } = useStores();
    const collectionsStore = useCollectionsStore();
    // ...
  },
};
```

## A complete minimal example

A layout that renders items as a simple list of names. Just a main component with no extra slot work.

`src/index.js`:

```js
import { defineLayout, useCollection, useItems, useSync } from '@cairncms/extensions-sdk';
import { computed, toRefs } from 'vue';
import LayoutComponent from './layout.vue';

export default defineLayout({
  id: 'simple-list',
  name: 'Simple list',
  icon: 'list',
  component: LayoutComponent,
  slots: {
    options: () => undefined,
    sidebar: () => undefined,
    actions: () => undefined,
  },
  setup(props, { emit }) {
    const layoutQuery = useSync(props, 'layoutQuery', emit);
    const { collection, filter, search } = toRefs(props);
    const { primaryKeyField } = useCollection(collection);

    const { items, loading } = useItems(collection, {
      sort: computed(() => layoutQuery.value?.sort ?? [primaryKeyField.value?.field ?? 'id']),
      limit: computed(() => 50),
      fields: computed(() => ['*']),
      filter,
      search,
      page: computed(() => 1),
    });

    return { items, loading };
  },
});
```

`src/layout.vue`:

```vue
<template>
  <div class="simple-list">
    <p v-if="loading">Loading…</p>
    <ul v-else>
      <li v-for="item in items" :key="item.id">{{ item.name ?? item.id }}</li>
    </ul>
  </div>
</template>

<script setup>
defineProps({
  items: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
});
</script>
```

Build with `npm run build`, then install or symlink the package into a CairnCMS instance. The new layout becomes available in the layout selector for any collection.

## Where to go next

- [Interfaces](/docs/develop/extensions/interfaces/) and [Displays](/docs/develop/extensions/displays/) cover field-level customization.
- [Modules](/docs/develop/extensions/modules/) cover entirely new top-level workspaces, beyond the scope of one collection.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full.
