---
title: Bundle extensions
description: Combine several extensions into a single distributable package.
---

A bundle is the wrapper extension type for distributing several extensions as a single npm package. The bundle itself is registered with `type: 'bundle'`, and inside it sits an `entries` array describing the nested extensions: interfaces, displays, hooks, operations, and so on. Bundles let entries share dependencies, share a build, and ship under one name.

## When to use a bundle

Reach for a bundle when:

- Several extensions implement one feature together (a custom collection plus the interface that edits its values plus the hook that validates writes plus the operation that processes them).
- A set of extensions share heavy dependencies and you do not want to install them three or four times.
- You want a single version, a single changelog, and a single npm package for a feature that spans the app and the API.

Stay with separate single-type packages when:

- The extensions are unrelated and only happen to be authored by the same person.
- One of the extensions is meaningfully large and would muddle a smaller one's release cadence.
- You expect operators to mix and match — not every consumer needs every extension.

A bundle is a packaging decision, not an architectural one. The individual extensions inside it work the same way they would as standalone packages.

## Scaffolding a bundle

Run the scaffolder and choose `bundle` as the extension type:

```bash
npm init cairncms-extension
```

The scaffolder creates an empty bundle package. From there, use the SDK CLI to add entries.

## Adding entries

Inside the bundle directory, run:

```bash
cairncms-extension add
```

The CLI prompts for the entry's type, name, and language, then:

- creates `src/<name>/...` with the appropriate template files
- adds an entry to the `cairncms:extension.entries` array in `package.json`

Existing extensions can also be added by hand: copy the source into the bundle's `src/` directory and add a matching entry to the manifest.

## The manifest

The bundle's `package.json` carries `cairncms:extension` with `type: "bundle"`, an `entries` array, and a `path` object pointing to the built output:

```json
{
  "cairncms:extension": {
    "type": "bundle",
    "path": { "app": "dist/app.js", "api": "dist/api.js" },
    "entries": [
      {
        "type": "interface",
        "name": "color-grid",
        "source": "src/color-grid/index.ts"
      },
      {
        "type": "hook",
        "name": "validate-colors",
        "source": "src/validate-colors/index.ts"
      },
      {
        "type": "operation",
        "name": "apply-palette",
        "source": {
          "app": "src/apply-palette/app.ts",
          "api": "src/apply-palette/api.ts"
        }
      }
    ],
    "host": "^1.0.0"
  }
}
```

A bundle always builds two outputs (`dist/app.js` and `dist/api.js`), even when its entries are all on one side. The unused side is essentially empty but still present.

## Entry shape

Each entry in the `entries` array describes one nested extension. There are two shapes depending on the entry's type:

- **App or API entries** — `{ type, name, source }` where `source` is a string pointing to the entrypoint file. Used for `interface`, `display`, `layout`, `module`, `panel`, `hook`, and `endpoint`.
- **Hybrid entries** — `{ type, name, source }` where `source` is `{ app, api }` pointing to two entrypoint files. Used for `operation`.

`type` must be a real extension type. `bundle` cannot nest inside `bundle`. Convention-based customizations (custom migrations, email templates) are not extension types and cannot live inside a bundle either.

## Building

Run `npm run build` from the bundle's root, same as any other extension. The SDK CLI handles the multi-entry build. It walks `entries`, runs Rollup against each one, and combines the outputs into the two split bundles.

The `--watch` flag works the same way it does for single-extension packages and rebuilds whenever any entry's source changes.

## Removing an entry

To remove an extension from a bundle:

1. Delete the entry's directory under `src/`.
2. Remove the matching entry from `cairncms:extension.entries`.

Rebuild to update the dist outputs.

## A complete minimal example

A bundle that ships a custom interface plus the action hook that fires when fields using that interface are written.

`package.json` (relevant excerpt):

```json
{
  "cairncms:extension": {
    "type": "bundle",
    "path": { "app": "dist/app.js", "api": "dist/api.js" },
    "entries": [
      { "type": "interface", "name": "tracker", "source": "src/tracker/index.ts" },
      { "type": "hook", "name": "tracker-audit", "source": "src/tracker-audit/index.ts" }
    ],
    "host": "^1.0.0"
  }
}
```

`src/tracker/index.ts`:

```ts
import { defineInterface } from '@cairncms/extensions-sdk';
import Component from './tracker.vue';

export default defineInterface({
  id: 'tracker',
  name: 'Tracker',
  icon: 'analytics',
  component: Component,
  types: ['string'],
  options: null,
});
```

`src/tracker-audit/index.ts`:

```ts
import { defineHook } from '@cairncms/extensions-sdk';

export default defineHook(({ action }, { logger }) => {
  action('items.update', (meta) => {
    if (meta.payload && Object.keys(meta.payload).some((k) => k.startsWith('tracker_'))) {
      logger.info({ collection: meta.collection, keys: meta.keys }, 'tracker field updated');
    }
  });
});
```

Build with `npm run build`. The resulting package can be installed once and brings both extensions along.

## Where to go next

- [Creating extensions](/docs/develop/extensions/creating-extensions/) covers the toolchain in full, including how to install bundles.
- The individual extension type pages cover the API and minimum example for each entry type a bundle can contain.
