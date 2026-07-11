---
title: Item view extensions
description: Contextual split panes for the item editor.
sidebar:
  label: Item Views
  order: 7
---

An item view adds a contextual pane to the item editor for things like a live site preview, related records, a computed summary, or an embedded dashboard scoped to the record. The pane opens in a resizable split region beside the item form, behind a toggle button the platform renders in the editor's header.

An item view extension is a single npm package created by the [extensions toolchain](/docs/develop/extensions/creating-extensions/), or an entry inside a [bundle](/docs/develop/extensions/bundles/). Like every app extension, it runs unsandboxed in the admin browser under the logged-in user's permissions. See [App extensions](/docs/develop/extensions/app-extensions/) for the runtime model, the Vue baseline, and browser egress.

## Anatomy

The package's source entrypoint exports a configuration object built with `defineItemView`:

```js
import { defineItemView } from '@cairncms/extensions-sdk';
import PaneComponent from './item-view.vue';

export default defineItemView({
  id: 'custom',
  name: 'Custom',
  icon: 'box',
  placements: {
    splitPane: {
      component: PaneComponent,
      minWidth: 400,
    },
  },
});
```

`defineItemView` is a no-op type wrapper. It returns the config unchanged but gives you full TypeScript inference on the shape.

## Configuration

- **`id`** — unique key within the package. The platform pairs it with the package name, so ids never collide across extensions.
- **`name`** — display name, used as the toggle button's tooltip and in the extensions listing.
- **`icon`** — icon name from the Material icon set, used on the toggle button.
- **`enabled`** — optional function that decides whether the contribution exists on the current item page. It receives the pane context, may return a boolean, a `Ref<boolean>`, or a promise, and is re-evaluated when the collection changes. Absent means always enabled. A function that throws disables the contribution.
- **`placements`** — where the contribution renders. Placement names are a closed platform vocabulary. `splitPane` is the available placement. A config without a supported placement is skipped with a console warning.
- **`placements.splitPane.component`** — the Vue component rendered into the split region.
- **`placements.splitPane.minWidth`** — optional minimum pane width in pixels. On narrow windows the platform hides the item form rather than shrinking the pane below this.

The toggle button is platform-rendered from `name` and `icon`. A contribution never declares its own trigger. One pane is active at a time, activating another contribution switches the region, and activating the current one closes it. The open pane is a per-browser preference (localStorage), not account or project state.

## The pane context

Inside the pane component, `useItemViewContext` returns the read-only contract the platform provides:

```vue
<template>
  <div class="pane">
    <p>{{ collection }} / {{ isNew ? 'new' : (primaryKey ?? 'singleton') }}</p>
    <p>Saved title: {{ item?.title }}</p>
  </div>
</template>

<script setup>
import { useItemViewContext } from '@cairncms/extensions-sdk';

const { collection, primaryKey, isNew, item, onSaved, settings } = useItemViewContext();

onSaved(async () => {
  const template = await settings.get('preview_url');
  // refresh whatever the pane derives from the saved item
});
</script>
```

- **`collection`** — `Ref<string>`, the collection being edited.
- **`primaryKey`** — `Ref<string | null>`. Null for singletons. A new, unsaved item carries the placeholder key `+`, so use `isNew` to detect new items.
- **`collectionInfo`** — `Ref<Collection | null>`, the collection's metadata.
- **`isNew`** — `Ref<boolean>`.
- **`item`** — readonly ref holding the saved item values. It reflects the last saved state, not unsaved edits, and updates after a save.
- **`onSaved(callback)`** — registers a callback that fires after a successful save that keeps the editor open, with the fresh saved values. Callbacks registered from the pane's setup are disposed when the pane closes.
- **`settings.get(key)`** — reads the extension's own [package settings](/docs/develop/extensions/settings/) for the current collection. Only keys marked `appReadable` resolve, and collection-scoped values resolve only when the signed-in user has read permission on the collection. Undeclared keys resolve `null`. A failed request rejects and the next read retries.

The settings reader is bound to the contribution's owning package (for a bundle entry, the bundle), so a pane reads its own configuration without naming a subject. Every app extension shares the browser page and the user's session, and the underlying endpoint serves any app-readable subject to any signed-in user with app access, subject to the collection read gate above.

## Embedding external content

A pane that frames an external site (for example, a preview, or an embedded dashboard) has two gates to pass:

1. **The admin app's Content Security Policy.** The default policy allows frames from the app's own origin only, so an external iframe is blocked until the operator allows its origin:

   ```
   CONTENT_SECURITY_POLICY_DIRECTIVES__FRAME_SRC="array:'self',blob:,https://preview.example.com"
   ```

   The value replaces the frame policy outright, so it must re-include `'self'` and `blob:` alongside the allowed origin.

2. **The target site's own headers.** A site that sends `X-Frame-Options` or a restrictive `frame-ancestors` refuses to be framed. That is the target site's configuration, not something CairnCMS can override.

Treat a framed URL as an injection sink when it interpolates item data. Keep the scheme and host literal, encode interpolated values per URL component, set `referrerpolicy="no-referrer"` so the admin URL does not leak to the framed site, choose the iframe `sandbox` flags deliberately, and never place CairnCMS tokens in a framed URL.

## Per-collection configuration

An item view that behaves differently per collection declares [collection-scoped settings](/docs/develop/extensions/settings/). The operator edits them on each collection's data-model page, and the pane reads them through the bound `settings` reader. A string setting that holds a field template can declare `presentation: { "interface": "system-display-template" }` to render the field-aware template input there.

## Where to go next

- [Package settings](/docs/develop/extensions/settings/) — declaring, scoping, and reading extension configuration.
- [Creating extensions](/docs/develop/extensions/creating-extensions/) — scaffold (`item-view` type), build, install, hot reload.
- [Bundles](/docs/develop/extensions/bundles/) — shipping an item view alongside other entries under one package.
