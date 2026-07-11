---
title: UI components
description: The component library and theme tokens available to app extensions.
sidebar:
  label: UI components
  order: 9
---

The admin app registers its component library globally, so an app extension can use those components in its own Vue templates without importing them. They are the same components the app is built from, so an extension that uses them looks and behaves like the rest of the application and stays consistent across themes.

```vue
<template>
  <v-notice type="warning">Heads up.</v-notice>
  <v-button @click="save">Save</v-button>
</template>
```

A globally registered `VButton` is used as `<v-button>` in a template.

## Commonly used components

This is a working subset, grouped by purpose. The registered set is larger.

- **Inputs and forms** — `v-input`, `v-textarea`, `v-select`, `v-checkbox`, `v-radio`, `v-slider`, `v-form`, `v-field-template`, `v-template-input`, `v-upload`, `v-date-picker`.
- **Actions** — `v-button`, `v-icon`, `v-chip`.
- **Containers and overlays** — `v-card`, `v-sheet`, `v-drawer`, `v-dialog`, `v-menu`, `v-overlay`, `v-divider`, `v-detail`, `v-tabs`, `v-tab`.
- **Lists and tables** — `v-list`, `v-list-item`, `v-table`, `v-pagination`, `v-item-group`.
- **Feedback and status** — `v-notice`, `v-error`, `v-info`, `v-progress-circular`, `v-progress-linear`, `v-skeleton-loader`, `v-badge`, `v-avatar`.
- **Rendering helpers** — `render-template` (renders a display template for an item), `render-display` (renders a single field display).

The component registry is the current catalog. If you need a component that is not listed here, check what the app registers before building your own.

## Theme tokens

Use the theme's CSS variables for color, spacing, and radius rather than hard-coded values, so an extension follows the active theme automatically. The common tokens:

- **Color** — `--primary`, `--primary-alt`, `--background-page`, `--background-normal`, `--background-subdued`, `--background-input`, `--foreground-normal`, `--foreground-subdued`.
- **Shape** — `--border-radius`, `--border-radius-outline`.

```vue
<style scoped>
.badge {
  background-color: var(--primary);
  color: var(--foreground-inverted);
  border-radius: var(--border-radius);
}
</style>
```

A component or field that hard-codes a hex color breaks under a different theme. Reaching for a token keeps it theme-aware.

## Where to go next

- [App extensions](/docs/develop/extensions/app-extensions/) covers the browser lane.
- [Composables](/docs/develop/extensions/app-extensions/composables/) covers the data and store composables that pair with these components.
