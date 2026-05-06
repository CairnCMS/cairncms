---
title: Settings
description: Project settings, translation strings, and the rest of the Settings module.
---

The Settings module is where the project itself is configured, including branding, the module bar, password policy, file transformation rules, the Mapbox integration, image editor presets, and translation strings. It also hosts the data model, roles and permissions, presets and bookmarks, webhooks, and flows configuration screens, which are covered on their own guides.

Only roles with admin access can open Settings.

## Project Settings

Project Settings is one of the configuration areas inside the Settings module. (The module's default landing page is Data Model; Project Settings is reached from the Settings navigation pane.) It holds global configuration for the project: branding, security, file transformation rules, and so on. Changes are saved as a single record (`directus_settings`) and apply across the platform immediately.

### General

- **Project Name** — the name shown in the navigation pane, on the login page, and in browser titles
- **Project Descriptor** — a shorter line shown below the project name on login and public pages
- **Project URL** — where clicking the logo at the top of the module bar takes you
- **Default Language** — the language the app starts in for users who have not set a personal preference

### Branding and style

- **Project Color** — the accent color used by the project logo, the favicon, and the login page
- **Project Logo** — a 40×40 logo shown at the top of the module bar and on login and public pages. The image is inset within a 64×64 square filled with the project color. PNG is the most reliable format.
- **Public Foreground** — an image shown on the public-page right pane, max width 400px
- **Public Background** — full-bleed image behind the public foreground. If unset, the project color fills this area instead.
- **Public Note** — a short text note shown at the bottom of the public page right pane
- **Custom CSS** — CSS rules layered on top of the app's default styling. The app's internal DOM selectors can change between releases, so custom CSS is best used sparingly and re-checked after upgrades.

### Module bar

This section configures which modules appear in the left-hand module bar and in what order.

- Toggle visibility per module
- Drag to reorder modules
- Add custom links pointing to internal app routes (start with `/`) or external URLs

Custom links can carry a name, an icon, and a URL.

### Security

- **Auth Password Policy** — sets the regex that user passwords must match. The built-in choices are:
  - **None** — no enforcement (not recommended)
  - **Weak** — minimum 8 characters
  - **Strong** — uppercase, lowercase, numbers, and special characters
  - **Other** — supply a custom JavaScript regex
- **Auth Login Attempts** — number of failed logins before a user account is locked. Once locked, an admin must unlock it manually.

### Files and storage

CairnCMS can transform images on the fly when they are requested. This section controls which transformations are allowed and which preset transformations are predefined.

- **Allowed Transformations** — enable, disable, or restrict on-the-fly transformations
- **Default Folder** — where new files land by default when no folder is selected. File and image fields can override this per field.
- **Transformation Presets** — named transformations that callers can request by key, instead of passing every parameter on each request

Each preset has:

- **Key** — the identifier used in asset URLs
- **Fit** — Contain (preserves aspect ratio), Cover (exact size), Fit Inside, or Fit Outside
- **Width** / **Height** — output dimensions
- **Quality** — output compression
- **Upscaling** — whether the source can be enlarged
- **Format** — output format
- **Additional Transformations** — any further options passed through to the underlying image library

Presets exist primarily to reduce the surface area of allowed asset URLs. If a public site requests `?key=thumb` instead of `?width=200&height=200&fit=cover&...`, it is harder for an attacker to fan out random sizes against your storage.

### Mapping

If your project uses geospatial data, configure Mapbox here.

- **Mapbox Access Token** — issued from your Mapbox account
- **Basemaps** — custom tile configurations that override the Mapbox defaults. Each basemap has a name, a type (Raster, Raster TileJSON, or Mapbox Style), tile size, URL, and attribution string.

### Image editor

The image editor on the file detail page lets users crop to fixed aspect ratios. This section configures which custom ratios appear in the editor.

- **Custom Aspect Ratios** — adds named ratios. Each entry has a label and a numeric value.

The numeric value is the ratio expressed as a fraction. A 16:10 ratio is `1.6` (16 ÷ 10). A 16:9 ratio is `1.7778` (16 ÷ 9, rounded).

## Translation strings

Translation strings are key-value pairs that translate UI labels and content into other languages without changing the underlying schema. They are stored as a JSON array on the `directus_settings` record (the `translation_strings` field) and reused throughout the app wherever a field, label, dropdown option, or note supports translation.

### Creating a translation string

1. Go to **Settings > Translation Strings**.
2. Click the create button in the page header.
3. Enter a key, then add one translation per language. Each translation is its own row inside the string.
4. Save.

A translation string can carry as many language entries as you need. If a user is set to a language that the string has no entry for, the raw key is shown instead.

### Using a translation string

In the Settings module, fields that accept translation strings show a translate icon next to them. There are two ways to apply a string to such a field:

- click the translate icon and pick a key from the dropdown
- type `$t:your-string-key` directly into the field

The translate dropdown also has an option to create a new translation string inline.

Once applied, the field renders the language-appropriate translation based on the user's language preference, falling back to the project default language.

There are two places a user's language is set:

- **Project default** — under **Settings > Project Settings > General**. Used for users who have not set a personal preference.
- **Per user** — under the user's profile in the User directory. Overrides the project default for that user.

## Other settings areas

The Settings module also contains the configuration screens for several features documented separately:

- [Data model](/docs/guides/data-model/) — collections, fields, and relationships
- [Permissions](/docs/guides/permissions/) — roles and the CRUDS permissions matrix
- Presets & Bookmarks — saved views; covered briefly in [Layouts](/docs/guides/content/layouts/)
- [Automate](/docs/guides/automate/) — flows and webhooks

The Settings navigation pane also exposes shortcut links at the bottom for the current platform version, reporting a bug, and requesting a feature, all pointing to the CairnCMS GitHub repository.

## Where to go next

- [Auth](/docs/guides/auth/) covers password policies, two-factor enforcement, and SSO at the role and instance level.
- [Files](/docs/guides/files/) covers how the storage backends and folders work alongside the file transformation presets configured here.
