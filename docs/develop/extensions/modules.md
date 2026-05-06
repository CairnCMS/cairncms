---
title: Module extensions
description: Custom top-level modules for the module bar.
---

A module is a top-level area of the admin app. CairnCMS ships six built-in modules: Content, User Directory, File Library, Insights, Settings, and Activity (the last is registered with `hidden: true` and reached via the Activity Log link in the sidebar rather than the module bar). A module extension adds a new one.

Modules are the broadest extension type. Where an interface affects a single field and a layout affects a single collection page, a module is an entire workspace with its own routes, navigation, and page structure. Reach for a module when none of the existing surfaces fit and you need a custom area inside the app.

A module extension is a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/). It registers a set of routes, each rendered by a Vue component.

## Anatomy

The package's source entrypoint exports a configuration object built with `defineModule`:

```js
import { defineModule } from '@cairncms/extensions-sdk';
import ModuleComponent from './module.vue';

export default defineModule({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  routes: [
    {
      path: '',
      component: ModuleComponent,
    },
  ],
});
```

`defineModule` is a no-op type wrapper; it returns the config unchanged but gives you full TypeScript inference on the shape.

## Configuration

The fields available on a module configuration object:

- **`id`** — unique key. Also serves as the base path for the module's routes (`/<id>` reaches its root). Scope proprietary modules with an author or organization prefix.
- **`name`** — display name shown in tooltips and accessible labels.
- **`icon`** — icon name from the Material icon set or one of CairnCMS's custom icons. Shown as the module's button in the module bar.
- **`color`** — optional accent color for the icon.
- **`routes`** — array of Vue Router route records describing the pages inside the module.
- **`hidden`** — when `true`, the module is registered but never appears in the module bar. Useful for modules that exist only to be linked into from elsewhere (or for routes that need to live outside any visible module).
- **`preRegisterCheck`** — optional sync or async function that gates whether the module is registered for the current user. See below.

## Routes

The `routes` array is a Vue Router route table. CairnCMS mounts it under `/<module-id>`, so paths inside the array are relative and should not start with a slash.

The button in the module bar links to `/<module-id>`, so the routes array should always include a root route with `path: ''`:

```js
routes: [
  {
    path: '',
    component: OverviewView,
  },
  {
    path: 'detail/:id',
    component: DetailView,
    props: true,
  },
];
```

Nested children, named routes, redirects, and other Vue Router features all work normally. See the Vue Router documentation for the full route record shape.

## Route components

Each route's `component` is a Vue component that renders into the main page area inside the module — the space framed by the module bar, navigation pane, header, and sidebar. To pick up that page chrome, wrap the component's content in the globally-registered `private-view` element:

```vue
<template>
  <private-view title="My Custom Module">
    <p>Content goes here.</p>
  </private-view>
</template>
```

`private-view` accepts slots for `headline`, `title-outer:prepend`, `actions`, `navigation`, and `sidebar` which is the same slot pattern every built-in module uses. Without `private-view`, the route renders raw inside the page area but loses the page chrome.

## Adding the module to the module bar

A registered module does not appear in the module bar automatically. The operator must add it through **Settings > Project Settings > Modules**:

1. Open Project Settings.
2. In the Modules section, click **Add** and choose the new module.
3. Toggle it on and save.

Registering a module makes it available, but operators decide which modules show in the bar. To bypass this entirely (for a hidden helper module, for example), set `hidden: true` on the config.

## preRegisterCheck

`preRegisterCheck` is an optional function that runs before a module is registered for the current user. It receives the user record and the user's permissions, and returns a boolean (or a promise that resolves to one) indicating whether the module should be available.

```js
import { defineModule } from '@cairncms/extensions-sdk';

export default defineModule({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  routes: [/* ... */],
  preRegisterCheck(user, permissions) {
    if (user.role.admin_access) return true;

    return permissions.some(
      (p) => p.collection === 'directus_files' && p.action === 'read'
    );
  },
});
```

Use this to scope module visibility to a role or permission set. Returning `false` means the module is not registered for the current user. The route is unreachable and the entry never appears in the module bar.

## Accessing internal systems

The SDK exports three composables for reaching internal systems from a module's route components:

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

All three work in any Vue 3 setup, including Options-API components that pair an `options` block with a small `setup()` function.

## A complete minimal example

A module that lists every collection in the project.

`src/index.js`:

```js
import { defineModule } from '@cairncms/extensions-sdk';
import ModuleComponent from './module.vue';

export default defineModule({
  id: 'collections-overview',
  name: 'Collections Overview',
  icon: 'list_alt',
  routes: [
    {
      path: '',
      component: ModuleComponent,
    },
  ],
});
```

`src/module.vue`:

```vue
<template>
  <private-view title="Collections Overview">
    <ul>
      <li v-for="collection in collections" :key="collection.collection">
        {{ collection.collection }}
      </li>
    </ul>
  </private-view>
</template>

<script setup>
import { useStores } from '@cairncms/extensions-sdk';
import { computed } from 'vue';

const { useCollectionsStore } = useStores();
const collectionsStore = useCollectionsStore();

const collections = computed(() => collectionsStore.collections);
</script>
```

Build with `npm run build` and install or symlink the package. Then enable the module in **Settings > Project Settings > Modules** to make it appear in the module bar.

## Where to go next

- [Endpoints](/docs/develop/extensions/endpoints/) cover the API-side counterpart for modules that need their own server routes.
- [Hooks](/docs/develop/extensions/hooks/) cover server-side reactions to platform events; useful when a module needs to listen for or modify platform behavior.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full.
