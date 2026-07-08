---
title: Extensions
description: Managing installed extensions in the admin app. Reading extension health, opening diagnostics, and configuring the settings an extension declares.
sidebar:
  order: 9
---

This guide covers the operator side of extensions: reading their health on the Extensions page, understanding the diagnostics, and supplying the settings an extension declares. Installing and building extensions is developer work, covered in [Creating extensions](/docs/develop/extensions/creating-extensions/).

## The Extensions page

Settings > Extensions lists every extension found on the instance. The summary at the top counts extensions by health, and each row carries a health indicator:

- **Normal** — the extension loaded, or a browser app extension was discovered, with no reported warning or failure.
- **Warning** — something needs attention. For example, some of a bundle's entries failed while others loaded, or the extension's settings are unavailable.
- **Failed** — the extension did not load.

A row shows the extension's display name with the package name beneath it when the two differ. The package name is the durable identifier. The display name is derived from it for readability.

Selecting a row opens its details:

- a notice describing the current state, with the raw diagnostic (a stable code and redacted detail) shown in monospace for anything that failed or needs attention,
- the **Runtime** — Sandboxed, Full Authority, or Browser App,
- the declared capabilities of a sandboxed extension,
- a bundle's entries, each with its own status and reason.

The same information is available from the API at `GET /extensions`. See [Platform and utilities](/docs/api/system-collections/platform-and-utilities/#extensions-extensions).

## Editing extension settings

An extension that declares settings carries a **Settings** action in its row menu. It opens a drawer with the extension's global settings, rendered as ordinary fields. The extension author defines the fields, their order, and their widths, and the platform stores the values.

- Edit a value and save with the check button.
- Clear a stored value from the field's menu with **Clear Value** and save. The stored value is removed, not set to empty.
- A secret field never shows its stored value. Once a secret is saved, the field shows a locked, encrypted state. Entering a new value replaces the stored one.

Saving an inline secret requires `SECRETS_ENCRYPTION_KEY` to be configured on the deployment. If it is not, the save fails with a dialog naming the missing configuration. See [Configuration](/docs/manage/configuration/#extensions).

Some extensions also read secrets directly from deployment configuration. Those never appear as editable fields. The drawer shows a general notice that the extension uses deployment configuration, and the extension's own documentation should name the variables to set. See [Configuration](/docs/manage/configuration/#extensions) for how those variables are derived.

## Collection-scoped settings

An extension can declare settings that take one value per collection, such as a channel, a URL path, or a toggle that only makes sense for a specific collection. These do not appear in the drawer. They are edited in the data model by opening Settings > Data Model and selecting a collection, and an **Extension Settings** section appears below the fields list, one group per extension that declares collection-scoped keys. The values save with the collection page's save button.

## When settings are unavailable

A Warning row whose details say the extension's settings are unavailable means the platform refused the extension's settings identity. The diagnostic code says why, and each cause has an operator resolution:

- **`SETTINGS_SUBJECT_DUPLICATE`** — more than one installed extension uses the same package name. Remove or rename one of them.
- **`SETTINGS_SUBJECT_CONFIG_COLLISION`** — two installed packages derive the same config-secret deployment variable. Remove or rename one of the colliding packages.
- **`SETTINGS_SUBJECT_INVALID`** — the package name is not a valid extension name. This is an authoring defect; update to a corrected release of the extension.

An unavailable settings identity affects configuration only. It does not by itself block the extension from loading or running.

## Stored values and the extension lifecycle

Stored settings survive the extension they belong to. Uninstalling an extension preserves its values, and reinstalling it under the same package name picks them up again. Renaming a package is a new settings identity: the old values remain stored under the old name and the renamed extension starts empty.

## Where to go next

- [Extension settings](/docs/develop/extensions/settings/) — the developer side: how an extension declares the settings you configure here.
- [Configuration](/docs/manage/configuration/) — `SECRETS_ENCRYPTION_KEY` and the extension configuration variables.
- [Security hardening](/docs/manage/security-hardening/) — the trust model for full-authority versus sandboxed extensions.
