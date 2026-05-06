---
title: Creating extensions
description: Scaffolding, building, installing, and publishing a CairnCMS extension.
---

CairnCMS ships a small toolchain for creating extensions:

- **`create-cairncms-extension`** — scaffolds a new extension package with the right files and dependencies. Also reachable as `cce`.
- **`@cairncms/extensions-sdk`** — the SDK itself: `define*` helpers, types, and the `cairncms-extension` CLI used to build, watch, and link extensions during development.

Together they cover the lifecycle: scaffold → develop → build → install → publish.

## Scaffolding a new extension

The fastest way to start a new extension is the scaffolder:

```bash
npm init cairncms-extension
```

This walks you through interactive prompts: extension **type**, extension **name**, and (for everything except bundles) **language** (JavaScript or TypeScript). Bundles skip the language prompt because bundle code is structural rather than implementation. The result is an npm package configured for your chosen extension type, with `@cairncms/extensions-sdk` pre-installed.

The scaffolder is also available as a longer-named bin (`create-cairncms-extension`) and as the shorter `cce`:

```bash
npx create-cairncms-extension
# or
npx cce
```

The scaffolder always prompts interactively; CLI arguments are not read.

If you want to combine several extensions into one distributable package, scaffold a [Bundle](/docs/develop/extensions/bundles/) instead and add entries to it.

## Project structure

The scaffolder creates an npm package that looks like this (for a non-bundle extension):

```
my-extension/
├── package.json
├── src/
│   └── index.{js,ts}
└── ...
```

The `package.json` contains a `cairncms:extension` block with the extension's metadata:

```json
{
  "cairncms:extension": {
    "type": "interface",
    "path": "dist/index.js",
    "source": "src/index.js",
    "host": "^1.0.0"
  }
}
```

- **`type`** — one of the nine extension types (interface, display, layout, module, panel, hook, endpoint, operation, bundle).
- **`path`** — the built output the loader will read.
- **`source`** — the source entrypoint passed to the build.
- **`host`** — a semver range describing which CairnCMS versions this extension is compatible with.

The build CLI uses these fields by default. The `type`, `source`, and `path` values can be overridden at the command line; `host` cannot.

## Building

Build with:

```bash
npm run build
```

The generated `package.json` calls the SDK's CLI:

```json
{
  "scripts": {
    "build": "cairncms-extension build"
  }
}
```

Internally, the CLI uses Rollup to bundle the extension into a single entrypoint.

The build command supports several flags:

- **`-w`, `--watch`** — rebuild on file change. Use this during active development.
- **`--sourcemap`** — include source maps in the output.
- **`--no-minify`** — skip minification.
- **`-t`, `--type <type>`** — override the type from `package.json`.
- **`-i`, `--input <file>`** — override the source path.
- **`-o`, `--output <file>`** — override the output path.

Most projects only ever need the bare `build` command and `--watch`.

### Custom Rollup configuration

To extend the Rollup config — for example, to add a plugin — create one of these files at the root of the extension package:

- `extension.config.js`
- `extension.config.mjs`
- `extension.config.cjs`

```js
export default {
  plugins: [
    /* additional Rollup plugins */
  ],
};
```

The supported option is `plugins`, which is an array of Rollup plugins added on top of the SDK's built-in plugins.

## Live reloading during development

CairnCMS can reload extensions automatically when their files change on disk. Set the operator-side environment variable:

```bash
EXTENSIONS_AUTO_RELOAD=true
```

There is one important caveat: the extension watcher is intentionally disabled when `NODE_ENV=development`, on the assumption that development environments use a process-level reloader (nodemon, the dev script, and so on) that would conflict with the in-process watcher. To exercise the auto-reload path, leave `NODE_ENV` unset or set to `production`.

The combination most developers want is `cairncms-extension build --watch` running in one terminal (rebuilding the extension on file change) and CairnCMS running with `EXTENSIONS_AUTO_RELOAD=true` (picking up the rebuilt output without a manual restart).

## Symlinking a local extension

If you want CairnCMS to pick up an extension you are developing in a separate directory, symlink it into a CairnCMS extensions folder:

```bash
cairncms-extension link <path-to-extensions-folder>
```

The path argument is mandatory and is resolved as-is — the command does not read CairnCMS project configuration. Pass the absolute or relative path to the target instance's extensions folder, and the current package is symlinked into it. Changes to the source files are visible without copying or installing.

## Working on a bundle

Inside a bundle package, you can add new entries (sub-extensions) without editing the manifest by hand:

```bash
cairncms-extension add
```

This opens an interactive prompt for the entry's type, name, and language, then updates the bundle's `cairncms:extension.entries` array and creates the source files.

## Installing an extension

CairnCMS discovers extensions from three sources at startup. Pick whichever fits how you ship the extension.

### Package extensions

Install from npm into the project's `node_modules`. The loader auto-discovers packages whose names match any of:

- `cairncms-extension-<name>`
- `@<scope>/cairncms-extension-<name>`
- `@cairncms/extension-<name>`

```bash
cd <cairncms-project-folder>
npm install <package-name>
```

This is the right path for shipping an extension to other operators or for installing one published by someone else.

### Local package extensions

Place a full package directory (with its own `package.json`) inside `EXTENSIONS_PATH`. The loader treats these the same as installed packages but resolved from a local path. Bundles are typically installed this way.

### Local file extensions

For non-bundle extensions, place pre-built output into the type-folder layout:

```
<EXTENSIONS_PATH>/
├── interfaces/
│   └── my-interface/
│       └── index.js
├── displays/
│   └── ...
└── hooks/
    └── ...
```

For Operation extensions (which have both an app and an api side), use `app.js` and `api.js` instead of `index.js`:

```
<EXTENSIONS_PATH>/operations/my-operation/
├── app.js
└── api.js
```

This path is convenient for one-off extensions that do not need to live in their own package.

## Publishing to npm

To make an extension available to other CairnCMS operators, publish the npm package the SDK created:

1. Make sure the package name matches one of the auto-discovery patterns above.
2. Run `npm publish`.

Operators install with `npm install <name>` and CairnCMS auto-discovers it.

The CairnCMS extension naming convention exists so the loader can find packages without configuration. A package named `cairncms-extension-my-fancy-thing` is auto-discovered; a package named `my-fancy-thing` is not.

## Where to go next

- The individual extension type pages cover the API and minimum example for each:
  - [Interface](/docs/develop/extensions/interfaces/), [Display](/docs/develop/extensions/displays/), [Layout](/docs/develop/extensions/layouts/), [Module](/docs/develop/extensions/modules/), [Panel](/docs/develop/extensions/panels/)
  - [Hook](/docs/develop/extensions/hooks/), [Endpoint](/docs/develop/extensions/endpoints/)
  - [Operation](/docs/develop/extensions/operations/)
  - [Bundle](/docs/develop/extensions/bundles/)
