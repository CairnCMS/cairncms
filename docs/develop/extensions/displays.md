---
title: Display extensions
description: Custom read-only field renderers for the admin app.
---

A display is the read-only counterpart to an interface. Where an interface is the editing widget, a display is what the value looks like when it is shown in collection rows, in item summaries, in display templates, and anywhere else a field's value appears outside the item form.

CairnCMS ships built-in displays (raw, formatted value, datetime, color, image, filesize, and so on); a display extension adds a new one.

A display extension has two parts: a configuration object that registers the display with the app, and a Vue component that renders the value. Both live inside a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/).

## Anatomy

The package's source entrypoint exports a configuration object built with `defineDisplay`:

```js
import { defineDisplay } from '@cairncms/extensions-sdk';
import DisplayComponent from './display.vue';

export default defineDisplay({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  description: 'A custom display.',
  component: DisplayComponent,
  types: ['string'],
  options: null,
});
```

`defineDisplay` is a no-op type wrapper; it returns the config unchanged but gives you full TypeScript inference on the shape.

## Configuration

The fields available on a display configuration object:

- **`id`** — unique key. Scope proprietary displays with an author or organization prefix to avoid collisions.
- **`name`** — display name shown when an editor configures a field's Display section.
- **`icon`** — icon name from the Material icon set or one of CairnCMS's custom icons.
- **`description`** — short description (under 80 characters).
- **`component`** — the Vue component that renders the value. Can be a Single File Component or a functional component (see below).
- **`handler`** — optional sync function that returns a plain string for the value. Used in contexts where rendering a Vue component is overkill, such as display templates inside layouts. See [The handler function](#the-handler-function) below for the fallback behavior when this is not provided.
- **`options`** — configuration fields exposed in the field detail drawer when an editor sets up this display. Same shape as interface options: an array of field definitions, a `{ standard, advanced }` object, a function returning either, a Vue component for fully custom rendering, or `null` for no options.
- **`types`** — array of supported storage types. The display only appears in the Display selector for fields with a matching type.
- **`localTypes`** — array of supported local types: `standard`, `file`, `files`, `m2o`, `o2m`, `m2m`, `m2a`, `presentation`, `translations`, `group`. Defaults to `['standard']`.
- **`fields`** — array of related field names (or a function returning one) that the platform should pre-fetch and pass to the component as `value`. Use this when a display needs more than the field's stored value — for example, a display that shows an author's name alongside an article ID.

## The display component

The component receives the current value as a prop and renders it however you like. There is no `input` event, so displays do not mutate the value.

A minimal SFC component:

```vue
<template>
  <div>{{ value }}</div>
</template>

<script setup>
defineProps({
  value: { type: String, default: null },
});
</script>
```

### Props

The component receives the following props:

- **`value`** — the current field value. If `fields` is set on the display config, this is an object keyed by the requested field names instead of the raw field value.
- **`type`** — the field's storage type
- **`collection`** — the collection key
- **`field`** — the field key
- **`interface`** — the key of the interface configured on this field, when relevant
- **`interfaceOptions`** — the options object configured on the interface

Any additional values configured under `options` are passed as props as well.

The component is otherwise a blank canvas. Use any Vue 3 features and any third-party UI libraries that support Vue 3.

## Functional components

For simple displays that just transform a value into text, a functional component is shorter than an SFC:

```js
import { defineDisplay } from '@cairncms/extensions-sdk';

export default defineDisplay({
  id: 'lower',
  name: 'Lowercase',
  icon: 'text_format',
  component: ({ value }) => (value ?? '').toLowerCase(),
  options: null,
  types: ['string'],
});
```

The function receives the same props the SFC version would and returns either a string or a Vue VNode (use `h()` from `vue` if you need an element, not just text).

## The handler function

Some places in CairnCMS, such as display templates, in-table cell renders, and similar, need a plain string for a value, not a Vue component. The optional `handler` field is a sync function that returns that string:

```js
import { defineDisplay } from '@cairncms/extensions-sdk';
import { formatFilesize } from './format';

export default defineDisplay({
  id: 'filesize',
  name: 'Filesize',
  icon: 'description',
  component: ({ value }) => formatFilesize(value),
  handler: (value) => formatFilesize(value),
  options: [],
  types: ['integer', 'bigInteger'],
});
```

The handler signature is `(value, options, ctx) => string | null`, where `ctx` includes `interfaceOptions`, `field`, and `collection`.

If a display does not provide a handler, the platform uses the raw field value as the string representation, which is fine for already-stringy values, but unhelpful for any non-trivial formatting. Provide a handler whenever the display does anything beyond passing the value through.

## Pre-fetching relational fields

When a display needs values from a related collection, for example, when showing an author's name on an article row, list the related fields under `fields`:

```js
import { defineDisplay } from '@cairncms/extensions-sdk';

export default defineDisplay({
  id: 'author-card',
  name: 'Author card',
  icon: 'person',
  component: AuthorCard,
  options: null,
  types: ['integer', 'uuid'],
  localTypes: ['m2o'],
  fields: ['name', 'avatar.id', 'avatar.title'],
});
```

The platform fetches those fields alongside the parent record and hands the component an object as its `value` prop, keyed by the requested field names.

`fields` can also be a function: `(options, { collection, field, type }) => string[]`. Use the function form when the field list depends on the display's own options.

## Accessing internal systems

The SDK exports three composables for reaching internal systems from inside a display component:

- **`useApi()`** — an axios instance pre-configured to talk to the CairnCMS API as the current user
- **`useStores()`** — the Pinia stores the app uses internally (collections, fields, current user, and so on)
- **`useExtensions()`** — the registered-extension catalog, useful when one extension needs to inspect or compose with another

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

All three work in any Vue 3 setup, including Options-API components that pair an `options` block with a small `setup()` function.

## A complete minimal example

A display that shows an integer field as a star rating, capped at five stars.

`src/index.js`:

```js
import { defineDisplay } from '@cairncms/extensions-sdk';
import Component from './display.vue';

export default defineDisplay({
  id: 'star-rating',
  name: 'Star rating',
  icon: 'star',
  description: 'Renders an integer 0-5 as filled stars.',
  component: Component,
  handler: (value) => '★'.repeat(Math.min(5, Math.max(0, Number(value) || 0))),
  options: null,
  types: ['integer'],
});
```

`src/display.vue`:

```vue
<template>
  <span aria-label="rating">{{ stars }}</span>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  value: { type: Number, default: 0 },
});

const stars = computed(() =>
  '★'.repeat(Math.min(5, Math.max(0, Number(props.value) || 0)))
);
</script>
```

Build with `npm run build`, then install or symlink the package into a CairnCMS instance. The new display becomes available wherever an integer field's Display can be configured.

## Where to go next

- [Interfaces](/docs/develop/extensions/interfaces/) cover the editing-side counterpart — how a field's value is captured.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full.
