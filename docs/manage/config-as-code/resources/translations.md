---
title: Translations
description: Per-language files for custom translation strings, deletions, and database collation limits.
sidebar:
  order: 6
---

Snapshot creates a separate file for each language, such as `translations/en-US.yaml` and `translations/fr-FR.yaml`. Each file contains that language's custom strings captured from the source instance.

`translations/fr-FR.yaml`:

```yaml
language: fr-FR
translations:
  welcome_banner: Bienvenue
  save_button: Enregistrer
```

The filename must match `language`. Use a language code supported by the admin app's language picker.

## Literal strings

The map is flat. Dots in keys are literal characters, not nested paths. Keys may be empty and can contain up to 255 Unicode code points. Values are literal strings. Keys and values do not support environment placeholders.

An empty or omitted `translations` map requests removal of that language's stored strings.

## Removing strings or language files

When `translations` is listed in the manifest, apply reads all language files in `translations/`. A key missing from its language file requests deletion of that string. A missing language file requests deletion of all custom strings for that language. These deletions require `--destructive`.

Keep the other language files in the tree when deploying changes to one language. They do not need to be edited.

## Rename a key

The database may treat keys that differ only in case or accents as the same key. On a case-insensitive target, a case-only rename in one apply returns `CONFIG_INVALID`, even with `--destructive`.

Use two reviewed applies for that rename. First remove the old key on the source instance, capture a snapshot, and apply with `--destructive`. After confirming its deletion on the target, add the differently cased key on the source, capture again, and apply. The translation is absent between those runs, so coordinate that interval with its consumers.
