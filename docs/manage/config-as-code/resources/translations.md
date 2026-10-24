---
title: Translations
description: Language files for custom translation strings, complete-set deletions, and database collation limits.
sidebar:
  order: 6
---

Manage custom translation strings in one file per language.

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

## Complete-set management

When translations are managed, all language files together describe the complete desired set. Omitting a key requests deletion. Removing a language file requests deletion of all its stored custom strings. Deletions require `--destructive`.

An ordinary update can overwrite a translation changed on the target without destructive authorization. Fold intended target edits into the reviewed files before reapplying.

## Rename a key

The database may treat keys that differ only in case or accents as the same key. On a case-insensitive target, a case-only rename in one apply returns `CONFIG_INVALID`, even with `--destructive`.

Use two reviewed applies for that rename. First remove the old key from the otherwise complete desired set and apply with `--destructive`. After confirming its deletion, add the differently cased key and apply again. The translation is absent between those runs, so coordinate that interval with its consumers.
