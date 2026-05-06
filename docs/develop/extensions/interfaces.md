---
title: Interface extensions
description: Custom field editing widgets for the admin app.
sidebar:
  order: 2
---

An interface is the editing widget for a field — what users see and interact with when entering or modifying a value on the item form. CairnCMS ships a long list of built-in interfaces (input, dropdown, datetime, tags, color, and so on); a custom interface adds a new one.

An interface extension has two parts: a configuration object that registers the interface with the app, and a Vue component that renders the editing UI. Both live inside a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/).

## Anatomy

The package's source entrypoint exports a configuration object built with `defineInterface`:

```js
import { defineInterface } from '@cairncms/extensions-sdk';
import InterfaceComponent from './interface.vue';

export default defineInterface({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  description: 'A custom interface.',
  component: InterfaceComponent,
  types: ['string'],
  options: null,
});
```

`defineInterface` is a no-op type wrapper; it returns the config unchanged but gives you full TypeScript inference on the shape.

## Configuration

The fields available on an interface configuration object:

- **`id`** — unique key. Scope proprietary interfaces with an author or organization prefix to avoid collisions.
- **`name`** — display name shown in the **Create Field** picker.
- **`icon`** — icon name from the Material icon set or one of CairnCMS's custom icons.
- **`description`** — short description shown alongside the interface in the picker (under 80 characters).
- **`component`** — the Vue component that renders the editing UI.
- **`options`** — configuration fields exposed in the field detail drawer when an editor sets up this interface. Can be an array of field definitions, a `{ standard, advanced }` object that splits options into two tabs, a function that returns either of those (passed an extension context), a Vue component for fully custom rendering, or `null` for no options.
- **`types`** — array of supported storage types (`string`, `text`, `integer`, `boolean`, `json`, `geometry`, and so on). The interface only appears in the Create Field picker for fields with a matching type.
- **`localTypes`** — array of supported local types: `standard`, `file`, `files`, `m2o`, `o2m`, `m2m`, `m2a`, `presentation`, `translations`, `group`. Defaults to `['standard']`.
- **`group`** — which category in the Create Field picker this interface appears under: `standard`, `selection`, `relational`, `presentation`, `group`, or `other`. Defaults to `other`.
- **`order`** — sort order within the group.
- **`relational`** — `true` if this interface displays related records.
- **`hideLabel`** — hide the field label above the interface on the item page.
- **`hideLoader`** — hide the loading skeleton while the field is initializing.
- **`autoKey`** — auto-generate the field key from the field name during creation.
- **`recommendedDisplays`** — array of display extension IDs that pair well with this interface. Surfaced when an editor configures the field's Display section.
- **`preview`** — an SVG string used as the preview image in the Create Field picker. Typically imported from a `.svg` file with `?raw`.

## The interface component

The component renders the editing UI. It receives the current value as a prop and emits an event when the value changes.

A minimal SFC component:

```vue
<template>
  <input :value="value" @input="emit('input', $event.target.value)" />
</template>

<script setup>
defineProps({
  value: { type: String, default: null },
});

const emit = defineEmits(['input']);
</script>
```

### Props

The component receives the following props:

- **`value`** — the current field value
- **`type`** — the field's storage type
- **`collection`** — the collection key
- **`field`** — the field key
- **`fieldData`** — the full field configuration object
- **`primaryKey`** — the current item's primary key (or `'+'` for new items)
- **`width`** — the field's layout width (`half`, `half-right`, `full`, or `fill`)
- **`length`** — the field's `max_length` from the schema, when set
- **`disabled`** — whether the field is currently locked
- **`loading`** — whether the form is still loading
- **`autofocus`** — whether this field should grab focus on mount
- **`direction`** — text direction (`ltr` or `rtl`)

Any additional values configured under `options` are passed as props as well.

### Emits

- **`input`** — updates the value of this field. Emit the new value as the event payload.
- **`set-field-value`** — sets the value of a different field on the same item. Emit `{ field: '<other-field-key>', value: <new-value> }`.

The component is otherwise a blank canvas. Use any Vue 3 features and any third-party UI libraries that support Vue 3.

## Accessing internal systems

The SDK exports composables for reaching the API client, the platform stores, and other internal systems from inside an interface component:

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

`useApi()` returns an axios instance pre-configured to talk to the CairnCMS API as the current user. `useStores()` returns the Pinia stores the app uses internally — useful when an interface needs to read collection metadata, current-user info, or other platform state.

Both composables work in any Vue 3 setup, including Options-API components that pair an `options` block with a small `setup()` function.

## A complete minimal example

Putting it together: a single-line text input that uppercases its value on input.

`src/index.js`:

```js
import { defineInterface } from '@cairncms/extensions-sdk';
import Component from './interface.vue';

export default defineInterface({
  id: 'shouty-input',
  name: 'Shouty Input',
  icon: 'volume_up',
  description: 'Uppercases as you type.',
  component: Component,
  types: ['string'],
  group: 'standard',
  options: null,
});
```

`src/interface.vue`:

```vue
<template>
  <input
    :value="value ?? ''"
    @input="emit('input', $event.target.value.toUpperCase())"
  />
</template>

<script setup>
defineProps({
  value: { type: String, default: null },
});
const emit = defineEmits(['input']);
</script>
```

Build with `npm run build`, then install the resulting package or symlink it into a CairnCMS instance. The new interface appears under **Standard** in the Create Field picker.

## Where to go next

- [Displays](/docs/develop/extensions/displays/) cover the read-only counterpart — how a field's value is rendered in non-edit contexts like list rows.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full, including how to install and reload extensions during development.
