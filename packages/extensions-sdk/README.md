# @cairncms/extensions-sdk

A toolkit for developing CairnCMS extensions. Provides the scaffolding, build, and linking tools extension authors use during development.

## Install

The fastest way to start a new extension is via the scaffolder, which sets up `@cairncms/extensions-sdk` as a devDependency for you:

```sh
npm init cairncms-extension
```

To add the toolkit to an existing project:

```sh
npm install --save-dev @cairncms/extensions-sdk
```

## Usage

The package ships a `cairncms-extension` CLI binary:

```sh
npx cairncms-extension build                  # Bundle the extension to a single entrypoint
npx cairncms-extension add                    # Add entries to an existing extension
npx cairncms-extension create <type> <name>   # Scaffold a new extension
npx cairncms-extension link <path>            # Symlink the extension into a CairnCMS install
```

For full command reference and extension authoring guides, see the [documentation](https://cairncms.dev/docs).

## License

[MIT](./LICENSE).
