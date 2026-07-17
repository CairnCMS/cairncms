---
title: Creating extensions
description: Scaffolding, building, installing, and publishing a CairnCMS extension.
sidebar:
  order: 1
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

- **`type`** — one of the ten extension types (interface, display, layout, module, panel, item-view, hook, endpoint, operation, bundle).
- **`path`** — the built output the loader will read.
- **`source`** — the source entrypoint passed to the build.
- **`host`** — a semver range describing which CairnCMS versions this extension is compatible with.

The block can also declare a `settings` object: operator-managed settings, including secrets, that your extension's code reads at runtime. The package name owns the stored values and also derives the deployment variable names for config-sourced secrets, which are never stored. Renaming a published package leaves stored values behind under the old name and changes the derived variable names. See [Extension settings](/docs/develop/extensions/settings/).

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

Internally, most builds use Rollup to bundle the extension into a single entrypoint. Confined server artifacts use a separate self-contained build path instead, covered in [Confined extensions](#confined-extensions).

The build command supports several flags:

- **`-w`, `--watch`** — rebuild on file change. Use this during active development.
- **`--sourcemap`** — include source maps in the output.
- **`--no-minify`** — skip minification.
- **`-t`, `--type <type>`** — override the type from `package.json`.
- **`-i`, `--input <file>`** — override the source path.
- **`-o`, `--output <file>`** — override the output path.

Most projects only ever need the bare `build` command and `--watch`.

### Output format

The build CLI emits ESM by default for newly scaffolded extensions. The scaffolder writes `"type": "module"` into the generated `package.json`, and the build reads that field to choose the output format.

Existing extensions without a `"type"` field continue to emit CommonJS, so a rebuild does not change their loader behavior. To migrate an existing extension to ESM, add `"type": "module"` to its `package.json` and rebuild.

The output file extension overrides the manifest. A path ending in `.mjs` always emits ESM. A path ending in `.cjs` always emits CommonJS. App-side bundles always emit ESM regardless of `type`.

The same rules apply when building with explicit `-t -i -o` flags. The CLI consults the current directory's `package.json` to determine the `type`, with the same file-extension override.

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

### App extensions and the Vue baseline

An app extension does not bundle its own copy of Vue. It shares the admin app's Vue runtime, and because `vue` is a shared dependency, the build binds the extension to the host's Vue version. The host Vue is the floor the extension builds against.

So a host-Vue or SDK change means rebuilding the extension. A `dist` built against an older toolchain can fail to mount against a newer host runtime, and rebuilding against the current SDK realigns it.

## TypeScript

Choose **TypeScript** at the scaffolder's language prompt to get a typed extension. The scaffold adds a
`tsconfig.json`, a `typecheck` script, and a pinned toolchain (`typescript`, `vue` for app extensions, and
`@types/node` for server extensions).

Type-check your extension with:

```bash
npm run typecheck
```

That runs `tsc --noEmit`. The build does not type-check: `cairncms-extension build` uses esbuild, which strips
types without checking them, so run `typecheck` separately, in your editor, a pre-commit step, or CI.

What to import:

- Import the `define*` helpers and their types from `@cairncms/extensions-sdk`, for example `import { defineInterface } from '@cairncms/extensions-sdk'`. That package is the public authoring surface. Do not import CairnCMS internal packages directly.
- App extensions (interface, display, layout, module, panel, item view, and the app side of an operation) include a `shims.d.ts` that declares `*.vue` imports, so you can import a single-file component and keep it typed.

The scaffold pins exact toolchain versions for reproducibility, so an extension scaffolded today behaves the
same later regardless of new `typescript` releases. To move to a newer toolchain, bump the versions in your
`package.json`.

## Live reloading during development

CairnCMS can reload extensions when their files change on disk, with no manual restart. The API watcher is opt-in through an environment variable, off by default:

```bash
EXTENSIONS_AUTO_RELOAD=true
```

CairnCMS runs an in-process watcher for this. The API dev script (`tsx watch`) only tracks the API source, not the extension build output, so this watcher is what notices a rebuild. A multi-file build, such as the app and api halves of a hybrid or a bundle, settles into a single reload rather than one reload per file, so the server picks up the finished build instead of a half-written one.

You rebuild your extension with the build CLI in watch mode, and run CairnCMS one of two ways alongside it.

### Against the app dev server

Run the API and the admin app from the CairnCMS repo, with your extension linked into the repo's extensions folder. Each command is its own terminal:

```bash
# API, with the extension watcher enabled
EXTENSIONS_AUTO_RELOAD=true pnpm --filter api dev

# admin app dev server
pnpm --filter app dev

# your extension, rebuilding on every change
cairncms-extension build --watch

# link your extension into the repo's extensions folder (run once)
cairncms-extension link <path-to-cairncms-repo>/api/extensions
```

Vite watches the `api/extensions` folder directly. Editing an app extension (an interface, display, layout, module, panel, item view, or the app side of an operation or bundle) reloads the browser, and editing a server extension reloads in the API. Adding or removing an extension folder regenerates the Vite extension entrypoint. If the browser does not refresh automatically, refresh the page.

Two things to expect:

- The app reload is a full page reload, not a state-preserving hot swap. The extension registry is built once when the app boots and has no hot-accept boundary, so the page refreshes to load the new bundle. A `.vue` component inside an extension may still hot-update through the Vue plugin.
- The Vite dev server only watches `api/extensions`. It does not read a custom `EXTENSIONS_PATH`. For app development through Vite, the extension has to live under that folder.

### Against a running instance

Run a normal CairnCMS instance with `EXTENSIONS_AUTO_RELOAD=true` set in its environment, where the API serves the built app. Rebuild your extension and link it into the instance's extensions folder:

```bash
# your extension, rebuilding on every change
cairncms-extension build --watch

# link it into the running instance's extensions folder (run once)
cairncms-extension link <path-to-instance>/extensions
```

A server extension change takes effect on the next request. An app extension change is rebuilt into the served bundle on reload, but the browser still holds the app it loaded earlier, so refresh the page to load it.

## Debugging

Source maps let stack traces and breakpoints point at your extension source instead of the built output. They are opt-in through `--sourcemap` and stay off by default, because a built map embeds your source. Only enable them while debugging.

The build is also minified by default, so without a map a stack trace points at minified output. Add `--sourcemap` to map it back, and `--no-minify` as well if you want the built file itself readable.

### Server extensions

A server extension's stack traces and breakpoints map to source when CairnCMS runs under plain Node with source maps enabled. Build with `--sourcemap` and set `NODE_OPTIONS` on the instance:

```bash
# rebuild on change, with source maps
cairncms-extension build --watch --sourcemap

# run the instance with source maps, plus the inspector for breakpoints
export NODE_OPTIONS="--enable-source-maps --inspect"
```

Then attach a debugger to the inspector, for example the VS Code "Attach to Node Process" action.

One caveat: the monorepo dev server (`pnpm --filter api dev`) runs under `tsx`, which does not apply source maps to the loader's cache-busted imports, so it does not map server extension stack traces. For source-mapped server traces use a plain-Node instance, either a released build or `pnpm --filter api build` followed by `node --enable-source-maps dist/cli/run.js start`.

### App extensions

App extension breakpoints map to source through the Vite dev server. Build the extension with `--sourcemap` and run the admin app from source:

```bash
cairncms-extension build --watch --sourcemap
pnpm --filter app dev
```

Open the app, then in browser devtools set a breakpoint in your extension's source. It appears under its original path with readable content, because the Vite dev server chains your extension's map so breakpoints and stack frames resolve to source.

### What source maps expose

- CairnCMS never serves source maps over HTTP. The `/extensions/sources` route serves only the app entrypoint and its code chunks, never `.map` files, and the API-generated app bundle carries no map.
- The Vite dev server does serve maps to the browser in development, which is how app debugging works. Do not expose the dev server publicly while source maps are enabled, because a map embeds your source.
- Runtime errors follow the platform's existing behavior, which source maps do not change beyond the file and line a frame points at. In development, an unexpected (non-`BaseException`) error from an endpoint or a filter hook is logged and returned with its stack only to a requesting admin. A platform `BaseException` includes its development stack in the response extensions for any requester, per the existing error-handler behavior. Errors from action, init, and scheduled hooks are logged only. In production the stack is not included in the response. For REST and GraphQL request errors, the values CairnCMS identifies as secrets are redacted from the returned message and extensions (including a returned stack) and from that request's error log. In REST, the error log is redacted before the `request.error` filter runs. The filter then receives a separate, unredacted response-shaped payload rather than the live `Error` object, and the platform redacts that filter's output before sending the response. See [Security hardening](/docs/manage/security-hardening/) for how secrets are detected and the limits.

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

## Full-authority server dependencies and native modules

Full-authority server extensions (hooks, endpoints, operations, and the API side of a bundle) run as normal Node code in the API process. When the SDK builds one, it compiles your own source but does not bundle the packages you depend on. Each declared dependency stays as a regular import and resolves from the extension package's own `node_modules` at runtime. A confined extension is different: its build is self-contained with no externals, so native modules and unbundled runtime dependencies are not available to it. See [Confined extensions](#confined-extensions).

This is what lets server extensions use native modules. A bundler cannot inline a compiled binary, so a package like `sharp` could not be bundled. Because the server build leaves declared dependencies external instead, your extension ships its own copy and it loads like any other Node dependency.

To use a runtime dependency, declare it under `dependencies` (or `optionalDependencies`) in the extension's `package.json`, then install it into the package:

```bash
npm install sharp
```

The build externalizes everything in `dependencies` and `optionalDependencies`, so those packages must be present in the extension's `node_modules` when CairnCMS loads the extension. The package and local-package install paths described above both carry their dependencies. An npm-installed extension resolves them through normal Node resolution, and a local package folder in `EXTENSIONS_PATH` keeps its own `node_modules` next to its build output.

Native modules need the package or local-package install path. The dependency has to resolve from a `node_modules` directory, and the loose local-file layout has nowhere to install one.

Packages in `devDependencies` are still bundled, so build-time tooling such as `@cairncms/extensions-sdk` does not need to be installed at runtime. Run `npm install` before building so that tooling is available.

### Native modules on Docker and Alpine

The CairnCMS Docker image is based on Alpine, which uses musl rather than glibc. Most native modules publish prebuilt binaries for both, so installing the dependency in your extension package is usually all you need. `sharp`, for example, resolves a musl prebuilt on Alpine with no extra steps.

If a module has no prebuilt binary for your platform and compiles from source, install the build toolchain first. For `sharp` on Alpine:

```bash
apk add --no-cache build-base vips-dev
```

When you ship an extension in a custom image, install its dependencies during the image build so the binaries are present when CairnCMS starts.

### Do not rely on the platform's copy

CairnCMS uses some native libraries internally, including `sharp`. If your extension imports a package it declared but did not install, Node may walk up the directory tree and resolve the platform's copy instead. Do not depend on that behavior. The platform's internal packages and their versions are implementation details that can change between releases, and this fallback is not a compatibility guarantee. Install the dependencies your extension declares.

## Publishing to npm

To make an extension available to other CairnCMS operators, publish the npm package the SDK created:

1. Make sure the package name matches one of the auto-discovery patterns above.
2. Run `npm publish`.

Operators install with `npm install <name>` and CairnCMS auto-discovers it.

The CairnCMS extension naming convention exists so the loader can find packages without configuration. A package named `cairncms-extension-my-fancy-thing` is auto-discovered; a package named `my-fancy-thing` is not.

## Confined extensions

A standalone operation, endpoint, or hook can run its server code in the sandbox instead of the API process, and a confined bundle runs its server entries in the sandbox while its app entries still run in the browser. Scaffold a confined extension with the SDK's `create` command and the `--confined` flag. From a fresh start, run it through `npx`:

```bash
npx @cairncms/extensions-sdk create operation my-op --confined
```

The confined runtime supports the operation, endpoint, hook, and bundle types. The interactive `npm init cairncms-extension` scaffolder does not offer it, so use the `create` command for a confined extension. The authoring API is covered on each server type page and in the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) reference.

A confined extension is checked at two stages, build and load.

**Build.** The confined build bundles the server entry into a single self-contained artifact. It runs with Node builtins not externalized, so a `node:` import or any other unresolved import fails the build rather than failing at runtime. It then containment-checks the bundled inputs: an input that resolves inside the package or to a published dependency under `node_modules` is allowed, while a `workspace:`, `file:`, or `link:` dependency that resolves outside the package is refused. So a confined extension needs its dependencies installed as published `node_modules` entries before publication, not linked from a workspace.

**Load.** When the API loads a confined extension, it re-reads the manifest, scans the declared server source, and probes the built artifact inside the sandbox before admitting it. The static source scan runs here, at load, not at build. A failed gate is recorded as a load failure in the diagnostics with a sanitized reason.

See the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) page for the runtime model, the host API, and the full set of constraints.

## CLI reference

Two binaries are involved. The scaffolder bootstraps a new package, and the SDK CLI runs inside one.

The scaffolder is `npm init cairncms-extension` (also `npx create-cairncms-extension` or `npx cce`). It prompts for type, name, and language and does not read CLI arguments. It does not offer the confined runtime, so use the `create` command below for a confined extension.

The SDK CLI is `cairncms-extension`, available once `@cairncms/extensions-sdk` is installed. The generated `package.json` wires it into `npm run build`. Its commands:

- **`cairncms-extension create <type> <name>`** — scaffold an extension. Flags: `--language <javascript|typescript>` and `--confined` (for an operation, endpoint, hook, or bundle). See [Confined extensions](#confined-extensions).
- **`cairncms-extension add`** — add an entry to an existing bundle. See [Working on a bundle](#working-on-a-bundle).
- **`cairncms-extension build`** — bundle the extension. Flags: `-w`/`--watch`, `--sourcemap`, `--no-minify`, `-t`/`--type`, `-i`/`--input`, `-o`/`--output`. See [Building](#building).
- **`cairncms-extension link <path>`** — symlink the extension into a CairnCMS install's extensions folder. See [Symlinking a local extension](#symlinking-a-local-extension).

## Where to go next

- The individual extension type pages cover the API and minimum example for each:
  - [Interface](/docs/develop/extensions/app-extensions/interfaces/), [Display](/docs/develop/extensions/app-extensions/displays/), [Layout](/docs/develop/extensions/app-extensions/layouts/), [Module](/docs/develop/extensions/app-extensions/modules/), [Panel](/docs/develop/extensions/app-extensions/panels/)
  - [Hook](/docs/develop/extensions/server-extensions/hooks/), [Endpoint](/docs/develop/extensions/server-extensions/endpoints/)
  - [Operation](/docs/develop/extensions/server-extensions/operations/)
  - [Bundle](/docs/develop/extensions/bundles/)
