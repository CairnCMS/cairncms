---
title: Panel extensions
description: Custom dashboard panels for Insights.
sidebar:
  order: 6
---

A panel is a unit of analytics or interaction inside an Insights dashboard. CairnCMS ships six built-in panel types (Label, List, Metric, Time Series, Global Variable, Global Relational Variable); a panel extension adds a new one.

A panel extension is a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/). It registers a panel type with a Vue component, a configuration schema, and an optional query function that the platform calls to fetch the panel's data.

## Anatomy

The package's source entrypoint exports a configuration object built with `definePanel`:

```js
import { definePanel } from '@cairncms/extensions-sdk';
import PanelComponent from './panel.vue';

export default definePanel({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  description: 'A custom panel.',
  component: PanelComponent,
  options: [
    {
      field: 'text',
      name: 'Text',
      type: 'string',
      meta: { interface: 'input', width: 'full' },
    },
  ],
  minWidth: 12,
  minHeight: 8,
});
```

`definePanel` is a no-op type wrapper; it returns the config unchanged but gives you full TypeScript inference on the shape.

## Configuration

The fields available on a panel configuration object:

- **`id`** — unique key. Scope proprietary panels with an author or organization prefix.
- **`name`** — display name shown in the panel-type picker.
- **`icon`** — icon name from the Material icon set or one of CairnCMS's custom icons.
- **`description`** — short description (under 80 characters) shown alongside the panel in the picker.
- **`component`** — the Vue component that renders the panel.
- **`options`** — configuration fields exposed when an editor configures the panel. Same shape as other extension options: an array of field definitions, a `{ standard, advanced }` object, a function that returns either, a Vue component for fully custom rendering, or `null` for no options.
- **`query`** — optional function that returns a query (or array of queries) the platform should run before rendering the component. The result is passed to the component as a `data` prop.
- **`variable`** — set to `true` to mark the panel as a global-variable panel. Variables are addressable from other panels via mustache syntax.
- **`minWidth`** — minimum width in dashboard grid units.
- **`minHeight`** — minimum height in dashboard grid units.
- **`skipUndefinedKeys`** — array of option keys to preserve as `undefined` instead of dropping during config save. Rare; needed for options whose unset state is meaningful.

`minWidth` and `minHeight` are required. The dashboard grid prevents users from sizing the panel below those bounds.

## The query function

For panels that visualize data, the easiest way to fetch what they need is to declare a `query` function. The platform runs the query, passes the result to the component as a `data` prop, and re-runs it when the panel's options or relevant filters change.

```js
import { definePanel } from '@cairncms/extensions-sdk';

export default definePanel({
  id: 'count-card',
  name: 'Count Card',
  icon: 'numbers',
  component: CountCard,
  query: (options) => ({
    collection: options.collection,
    query: {
      aggregate: { count: '*' },
      filter: options.filter ?? {},
    },
  }),
  options: [
    {
      field: 'collection',
      name: '$t:collection',
      type: 'string',
      meta: { interface: 'system-collection', width: 'half' },
    },
  ],
  minWidth: 6,
  minHeight: 6,
});
```

The query function signature is `(options) => PanelQuery | PanelQuery[] | undefined`, where each `PanelQuery` is `{ collection, query }`:

- **`collection`** — the collection to query
- **`query`** — a standard CairnCMS query object (filter, fields, sort, limit, aggregate, groupBy, search, page)

When the function returns multiple queries, the platform runs each one and passes the results to the component as an array on the `data` prop in the same order. The `PanelQuery` type also has an optional `key` field, but the current runtime ignores it and generates its own internal hash for caching.

If a panel does not need server data, for example, a label panel, omit `query` entirely.

## Variable panels

Setting `variable: true` marks the panel as a global variable. Each variable panel exposes a `field` option whose value is the variable's name — for example, an editor sets `field` to `customer_id`, and other panels on the same dashboard then reference the variable as `{{ customer_id }}` in any option that supports data binding.

The variable name comes from the configured `field` option, not from the panel's `id`. A variable-panel extension is responsible for providing a `field` option (and typically a `defaultValue` option) that the editor fills in when adding the panel to a dashboard.

```js
import { definePanel } from '@cairncms/extensions-sdk';

export default definePanel({
  id: 'string-variable',
  name: 'String variable',
  icon: 'tag',
  variable: true,
  component: StringVariableComponent,
  options: [
    /* options for the editor to configure the variable */
  ],
  minWidth: 8,
  minHeight: 4,
});
```

Variable panels render as editable controls inside the dashboard. Editing the value re-runs every panel that references it. The two built-in variable panels (Global Variable, Global Relational Variable) are reference points for what the rendering looks like.

## The panel component

The component receives the panel's configured options as props (spread from the options object) plus several framework props.

A minimal SFC component:

```vue
<template>
  <div class="panel" :class="{ 'has-header': showHeader }">
    {{ text }}
  </div>
</template>

<script setup>
defineProps({
  showHeader: { type: Boolean, default: false },
  text: { type: String, default: '' },
});
</script>
```

### Props

The component receives the following framework props in addition to whatever is configured under `options`:

- **`id`** — the panel record's UUID
- **`dashboard`** — the parent dashboard's UUID
- **`showHeader`** — whether the panel header (icon, name, note) is currently shown. Useful for adjusting padding or styling based on the available space.
- **`width`** — the panel's current width in grid units
- **`height`** — the panel's current height in grid units
- **`now`** — a `Date` object captured when the dashboard was rendered. Use this rather than `new Date()` for time-sensitive calculations so all panels render against a consistent timestamp.
- **`data`** — the result of the `query` function, when one is configured. Either a single result (when `query` returns one `PanelQuery`) or an array of results (when it returns an array).

The configured option values are also passed in as named props matching their `field` keys.

The component is otherwise a blank canvas. Use any Vue 3 features and any third-party UI libraries that support Vue 3.

## Accessing internal systems

The SDK exports three composables for reaching internal systems from a panel component:

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

For data fetching, prefer the `query` function over manual API calls, because it integrates with the dashboard's lifecycle (refresh interval, filter changes, variable updates) without extra plumbing.

## A complete minimal example

A panel that displays the current item count for a chosen collection.

`src/index.js`:

```js
import { definePanel } from '@cairncms/extensions-sdk';
import PanelComponent from './panel.vue';

export default definePanel({
  id: 'item-count',
  name: 'Item Count',
  icon: 'tag',
  description: 'Shows the total number of items in a collection.',
  component: PanelComponent,
  query: (options) => {
    if (!options.collection) return;
    return {
      collection: options.collection,
      query: { aggregate: { count: '*' } },
    };
  },
  options: [
    {
      field: 'collection',
      name: 'Collection',
      type: 'string',
      meta: {
        interface: 'system-collection',
        width: 'full',
      },
    },
  ],
  minWidth: 6,
  minHeight: 6,
});
```

`src/panel.vue`:

```vue
<template>
  <div class="item-count">
    <span class="count">{{ count }}</span>
    <span v-if="collection" class="label">items in {{ collection }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  showHeader: { type: Boolean, default: false },
  collection: { type: String, default: null },
  data: { type: [Object, Array], default: null },
});

const count = computed(() => props.data?.[0]?.count ?? 0);
</script>
```

Build with `npm run build`, then install or symlink the package. The new panel type appears in the panel picker on any dashboard.

## Where to go next

- [Insights](/docs/guides/insights/) covers the dashboard and panel surface from a user perspective, which is useful context when deciding what a custom panel should look like.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full.
