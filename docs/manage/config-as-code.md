---
title: Config as code
description: Capture roles, permissions, folders, project settings, and extension settings to versioned files, review changes, and apply them across environments.
sidebar:
  order: 8
---

Use config-as-code to capture roles, permissions, folders, project settings, and extension settings, review changes in source control, and apply them across environments. Use the CLI for a directory of YAML files or the HTTP API for a single JSON or YAML document.

## What a config snapshot captures

A snapshot contains:

- **Roles** — every operator-managed role with its key, name, icon, description, access flags, and `enforce_tfa` setting.
- **Permissions** — the operator-defined rules attached to each role, grouped by role. Each permission rule includes the collection, action, field allow-list, item-level filter, validation, and presets.
- **Folders** — the file-library folder names and hierarchy. File contents are not included.
- **Project settings** — the operator-authored project configuration including branding text, the default language, the login and password policy, the module bar, asset presets and the transform mode, map settings, and the default storage folder.
- **Extension settings** — settings for installed extensions that declare them, grouped by extension subject (the package name). Secrets are represented by preserve markers or runtime references.

It does not contain:

- **Schema.** Collections, fields, and relations belong to [schema-as-code](/docs/manage/schema-as-code/) and ship in a separate snapshot.
- **Users and content.** Account records, collection items, uploaded files, and their metadata require a separate migration or backup.
- **The Public role record.** Public access is managed through `permissions/public.yaml`. There is no `roles/public.yaml`.
- **System-managed permissions.** Built-in rules, such as those supplied by `app_access: true`, are provided automatically by CairnCMS.
- **Image settings.** Config as code does not manage project files, so the project logo and the public foreground and background images are not captured.
- **Inline secret values.** A snapshot carries `$secret: preserve` for a stored extension secret. Supply its value separately on each instance.

## Managed scope

The `resources` list in `cairncms-config.yaml` selects what to manage:

```yaml
version: 2
resources:
  - roles
  - permissions
  - folders
  - settings
  - extension-settings
```

For roles, permissions, and folders, the files describe the complete desired set, and a record absent from that set is planned for deletion. Project settings is a single record and is never deleted. Extension settings are managed per subject, as described below. Omitted kinds are left alone, and in that case `resources: []` manages nothing.

Re-snapshotting an existing directory preserves its version and scope. Version 1 supports roles and permissions. Version 2 adds folders, project settings, and extension settings. To adopt one in an existing project, set `version: 2`, add `folders`, `settings`, or `extension-settings` to `resources`, then re-snapshot the source instance and review the files before applying elsewhere.

When `settings` is listed in `resources`, `config snapshot` writes the project settings from the database to `settings/project.yaml`. Applying the snapshot updates the target instance's settings. If you omit individual fields from the file, their values in the target database remain unchanged.

When `extension-settings` is listed in `resources`, a snapshot writes one file per extension subject with an available settings declaration, including subjects with no stored values. An apply manages only the subjects with a file. Each file is the complete desired set of that subject's declared stored values. Removing a key plans a deletion, which requires `--destructive`. Removing the whole file stops managing the subject and leaves its values untouched. See [Extension settings](#extension-settings) for secret handling and clearing values.

Roles and permissions can be managed independently. When both are managed, each permission set must reference a role declared in the config. When only permissions are managed, role references resolve against roles already in the target database.

Roles and folders are matched across environments by their keys. Keys remain unchanged when records are renamed or folders are moved. Preserve the keys in your snapshots so subsequent applies update the existing records.

Deleting a role also deletes its permissions and presets, and suspends and unassigns its users, even when those resources are outside the manifest's scope. Review the dry-run output before authorizing deletions.

Unlike [deleting a folder in the app](/docs/guides/files/#renaming-moving-and-deleting-folders), config apply does not relocate its contents. Before deleting a folder, move its files and clear or replace any settings or field references to it, such as retargeting the default storage folder. Child folders must be moved or deleted, and clearing the reference and deleting the folder can be part of the same config apply. If any of these remain at deletion time, the entire apply is refused with `CONFIG_FOLDER_IN_USE`. A dry run lists the blockers observed for each folder it would delete, and the apply checks again at deletion time.

## Two surfaces, one engine

Choose the surface that fits your deployment:

| | CLI | HTTP API |
|---|---|---|
| Input | Directory of YAML files | Single YAML or JSON document |
| Target | Local database or remote server with `--url` | Remote server with an admin token |
| Safety | Interactive confirmation | Opt-in query flags |

Both produce the same plans and apply the same scope rules. The CLI also requires filenames to match record identities: `roles/editor.yaml` must declare `key: editor`, and `folders/reports.yaml` must declare `key: reports`.

Extension-settings filenames are derived from the `subject` inside the file. Keep the snapshot-generated filename since a name that does not match its subject is rejected.

## The CLI

### Snapshot

Write the current configuration as a directory tree:

```bash
cairncms config snapshot ./config
```

The CLI prompts before overwriting a non-empty directory. Pass `--yes` to skip the prompt for unattended runs.

The output structure:

```
config/
├── cairncms-config.yaml          # manifest (version, resources)
├── roles/
│   ├── administrator.yaml        # one file per role, named after role.key
│   └── editor.yaml
├── permissions/
│   ├── editor.yaml               # one file per role's permissions
│   └── public.yaml               # public role's permissions (no roles/public.yaml)
├── folders/
│   ├── documents.yaml            # one file per folder, named after folder.key
│   └── reports.yaml
├── settings/
│   └── project.yaml              # project settings (a single record)
└── extension-settings/
    └── cairncms-extension-chat-notify-11fe5f91.yaml
```

For example, `folders/reports.yaml` places Reports under the folder whose key is `documents`:

```yaml
key: reports
name: Reports
parent: documents
```

An extension-settings file groups global values and collection-scoped values for its subject. For example, `extension-settings/cairncms-extension-chat-notify-11fe5f91.yaml`:

```yaml
subject: cairncms-extension-chat-notify
global:
  sender_name: CairnCMS
  api_token:
    $secret: preserve
collections:
  articles:
    channel: editorial
```

The extension declares the available keys, their types, and their scopes. The config file supplies their values. The preserve marker keeps the target's inline secret without copying it from the source.

Snapshot treats any record file whose filename and declared identity match as managed, including hand-authored files. It leaves other files unchanged during cleanup.

Symlinks must resolve to files or directories inside the config directory. Snapshot preserves valid links and removes only the link when cleaning up a stale record. Invalid or escaping links stop the command.

### Apply

Read a config directory and reconcile the database to it:

```bash
cairncms config apply ./config
```

The command compares the files with the database, prints the plan, and prompts before applying changes. If nothing has changed, it reports `No changes to apply.` and exits `0`.

Three flags adjust the flow:

- **`--dry-run`** — compute and print the plan without writing. Exits `1` when the plan contains changes and `0` when it is empty, which supports CI drift checks. Add `--format json` for the machine-readable plan. JSON is only available with `--dry-run`.
- **`--yes`** — skip the confirmation prompt.
- **`--destructive`** — authorize deleting managed roles, permissions, or folders absent from the config, and declared stored extension-setting values absent from a managed subject's file. Off by default.

Without `--destructive`, a plan containing deletions is displayed but not applied:

```
Apply refused: this plan contains 1 deletion.
Review the item above and run again with --destructive.
```

### Plan output

The CLI uses the same human-readable plan for dry runs, refusals, and confirmation. Changes are grouped by kind and operation:

```
The following changes will be applied:

Roles:
  - Create content-reviewer
  - Update editor
    - Set name to Managing Editor

Permissions:
  - Delete editor / articles / delete

Extension settings:
  - Create cairncms-extension-chat-notify / notify_updates
  - Update cairncms-extension-chat-notify / sender_name
    - Set value to Editorial
  - Delete cairncms-extension-chat-notify / api_token

Plan: 2 to create, 2 to update, 2 to delete.
```

Extension-setting updates show ordinary values. Inline secrets can only be preserved or deleted by config apply, so the plan shows a secret deletion by identity without its value. Preserve markers and config-sourced references produce no changes.

For each role deletion, the plan lists the cascading permission and preset deletions, the suspended users, and the affected active sessions:

```
Roles:
  - Delete editor
    - Permission removed: articles / read
    - Bookmark removed: Draft queue
    - User suspended: 6f2a1b90-c3d4-4e17-9a2b-8f0c1d2e3a4b
    - 2 active sessions affected
```

Permissions that target missing collections appear under a `Warnings:` heading. Warnings do not block the apply or change its exit code.

### Machine-readable output

Use `--format json` with `--dry-run` to emit one versioned JSON plan. Standard output contains only the document. Operational logs go to standard error, while plan warnings remain in the document's `warnings` array.

```bash
cairncms config apply --dry-run --format json ./config
```

```json
{
  "planVersion": 2,
  "manifestVersion": 2,
  "changes": [
    {
      "kind": "roles",
      "operation": "update",
      "identity": { "key": "editor" },
      "fields": { "name": { "before": "Editor", "after": "Managing Editor" } }
    },
    {
      "kind": "permissions",
      "operation": "delete",
      "identity": { "role": "editor", "collection": "articles", "action": "delete" },
      "impact": []
    },
    {
      "kind": "extension-settings",
      "operation": "create",
      "identity": { "subject": "cairncms-extension-chat-notify", "scope": "global", "scope_key": "", "key": "notify_updates" },
      "values": { "value": true }
    },
    {
      "kind": "extension-settings",
      "operation": "update",
      "identity": { "subject": "cairncms-extension-chat-notify", "scope": "global", "scope_key": "", "key": "sender_name" },
      "fields": { "value": { "before": "CairnCMS", "after": "Editorial" } }
    },
    {
      "kind": "extension-settings",
      "operation": "delete",
      "identity": { "subject": "cairncms-extension-chat-notify", "scope": "global", "scope_key": "", "key": "api_token" },
      "impact": []
    }
  ],
  "summary": { "create": 1, "update": 2, "delete": 2 },
  "warnings": [],
  "protections": []
}
```

`planVersion` identifies the output format, independently of the input's `manifestVersion`. Each change has a `kind`, `operation`, and `identity`. Creates include `values`, updates include `before`/`after` fields, and role deletions include their cascading `impact`. An empty plan has a zeroed `summary`.

An extension-setting identity includes `subject`, `scope`, `scope_key`, and `key`. Global settings use an empty `scope_key`, while collection-scoped settings use the collection name. Secret deletions carry no value.

`protections` lists reasons a plan cannot be applied, even with `--destructive`. Each entry includes a `code`, `message`, and contributing changes. Automation should branch on `code`, not message text.

`ADMIN_CONTINUITY_REQUIRED` prevents an apply from leaving the instance without an administrator role. You can transfer administrator access between roles in one apply. CairnCMS grants the new access before removing the old access.

Consumers must ignore unknown properties but reject an unknown `planVersion`, `kind`, or `operation`. An unfamiliar protection blocks the apply; an unfamiliar warning does not. Additive fields do not change `planVersion`.

### Applying to a remote instance

Pass `--url` to run `config apply` or `config snapshot` against a CairnCMS server instead of a local database:

```bash
cairncms config apply --url https://cms.example.com --yes ./config
cairncms config snapshot --url https://cms.example.com ./config
```

Remote mode uses the same directory and plan formats as local mode. It does not open a local database or require `DB_*` settings.

Provide an administrator's static token through exactly one source:

- **`CAIRNCMS_TOKEN`** for a CI secret or environment variable.
- **`CAIRNCMS_TOKEN_FILE`** for a mounted secret file. On Unix, the file must be owner-only.
- **`--token-stdin`** for a pipe or password-manager command.

The token is never accepted as a command-line value. Supplying zero or multiple sources is a usage error.

Use an absolute `http` or `https` URL without credentials, a query, or a fragment. Prefer `https`. The CLI warns before sending a token over unencrypted `http`, does not follow redirects or environment proxy settings, and blocks explicitly denied addresses.

A mutating remote apply requires `--yes`; a dry run does not. The target must run CairnCMS 1.6.0 or newer.

Remote mode uses the same dry-run, deletion, and exit-code rules as local mode. Perform a dry run to review the plan before applying. Requests time out after 30 seconds; set `CAIRNCMS_REMOTE_CONFIG_TIMEOUT` to a duration such as `60s` for slower deployments. After a mutating timeout, run `config snapshot` before retrying because the server may have committed the apply.

A remote snapshot is validated before writing to the directory. An incompatible response exits `3` and leaves the directory unchanged. If an apply response cannot be verified, the CLI also exits `3` and asks you to snapshot the current state before retrying.

The server's [run record](#run-record) can help diagnose a failed or timed-out apply. Its absence does not prove that nothing changed.

### Exit codes

Both config commands map their outcome to an exit code, so a pipeline can branch on the result without parsing output:

`config apply`:

| Outcome | Code |
|---|---|
| Empty plan, or a successful apply, or a declined confirmation, or `--help` | 0 |
| Dry run whose plan contains changes | 1 |
| Invalid configuration or command usage, or a refused apply | 2 |
| No database connection, system tables not installed, unreadable state, or an unexpected failure | 3 |

`config snapshot`:

| Outcome | Code |
|---|---|
| Snapshot written, a declined overwrite, or `--help` | 0 |
| Usage error, or an invalid existing tree | 2 |
| No database connection, system tables not installed, unreadable state, or an unexpected failure | 3 |

A `CONFIG_STATE_CHANGED` conflict exits `2`. Review a fresh plan before retrying.

In remote mode, server refusals (`4xx`), a server below version 1.6.0, and missing `--yes` exit `2`. Transport failures, server failures (`5xx`), and unrecognized or malformed responses exit `3`.

### Environment variables

Role names and descriptions, the project name, descriptor, URL, and Mapbox key, and ordinary extension-setting strings accept environment placeholders such as `{{CAIRNCMS_CONFIG_PROJECT_NAME}}`. The placeholder must occupy the entire field value. Use the `CAIRNCMS_CONFIG_` namespace for interpolation. The CLI resolves the variable before planning, and an unset variable stops the command. Folder fields and the default storage folder do not support interpolation.

When you snapshot into a directory that already declares a whole-value placeholder for one of these fields, the CLI keeps your committed placeholder instead of replacing it with the resolved value, even when the variable is unset or its value differs from the database. A fresh directory, a field the existing file does not already declare as a placeholder, and the HTTP snapshot return the stored value.

Extension secrets do not use this interpolation. Use `$secret: preserve` for an inline secret and keep the snapshot's `{{CAIRNCMS_EXT_*}}` reference for a config-sourced secret, as described under [Extension settings](#extension-settings).

For an ordinary extension-setting string, only a whole-value `{{CAIRNCMS_CONFIG_*}}` placeholder is interpolated. Any other placeholder-like string is stored as a literal value, so `{{OTHER}}` is kept verbatim rather than resolved or rejected. The one exception is a reserved `{{CAIRNCMS_EXT_*}}` reference, which is valid only in a config-sourced position and is never resolved by config. Role and project-setting placeholder handling is unchanged.

The HTTP API does not resolve `CAIRNCMS_CONFIG_*` placeholders. Send resolved ordinary values in the request body and carry config-sourced `CAIRNCMS_EXT_*` references verbatim.

To store a literal role name or description, avoid whole-value placeholder syntax such as `{{NAME}}`.

## The HTTP API

The HTTP endpoints require an administrator token.

### Retrieve a snapshot

```
GET /config/snapshot
GET /config/snapshot?export=yaml
GET /config/snapshot?manifest_version=1&resources=roles,permissions
```

Returns a current snapshot under `data`, or as a YAML attachment with `?export=yaml`.

Use `manifest_version` and `resources` to select the format and scope. The defaults are version 2 and all kinds supported by the selected version. Use `resources=` for an empty scope. The remote CLI supplies these parameters from your local manifest.

### Apply

```
POST /config/apply
POST /config/apply?dry_run=true
POST /config/apply?destructive=true
```

Send the snapshot's `data` object without the outer envelope, or the exported YAML document. The server accepts:

- `application/json`
- `application/yaml`, `application/x-yaml`, or `text/yaml`

Two query flags shape the apply:

- **`?dry_run=true`** — compute and return the plan without writing. The response is the plan document, not an apply summary.
- **`?destructive=true`** — authorize deletions during a mutating apply. Dry runs always return the complete plan.

Use `true` or `false` for these flags. Other values and repeated flags return `400 CONFIG_INVALID`.

A mutating apply returns a summary like this under `data`:

```json
{
  "roles": {
    "created": ["editor"],
    "updated": ["administrator"],
    "deleted": []
  },
  "permissions": {
    "created": 5,
    "updated": 3,
    "deleted": 0
  },
  "folders": {
    "created": ["reports"],
    "updated": [],
    "deleted": []
  },
  "settings": {
    "updated": []
  },
  "extension-settings": {
    "created": 1,
    "updated": 1,
    "deleted": 0
  }
}
```

The response includes the plan under `meta.plan`. A dry run instead returns the [plan document](#machine-readable-output) under `data`.

A plan containing deletions requires `?destructive=true`. Otherwise, nothing is applied and the response is `400 DESTRUCTIVE_CHANGES_REQUIRED`, with the planned deletions in `extensions.deletions`.

Administrator-continuity protection returns `400 CONFIG_PROTECTED_RECORD`, even with `?destructive=true`. Its `extensions.protection.code` is `ADMIN_CONTINUITY_REQUIRED`. A dry run returns `200` with this entry in `protections` so automation can detect it before applying.

### No diff endpoint

Use `POST /config/apply?dry_run=true` to preview changes. Each apply computes a fresh plan; it does not reuse a previous dry run. If required state changes between planning and the pre-write check, the apply is refused with `409 CONFIG_STATE_CHANGED`. Review a fresh plan before retrying.

## Audit records and events

For roles, permissions, folders, and project settings, config applies use the normal activity and revision tracking for each affected collection, including changes caused by a role deletion.

Applies are attributed:

- An HTTP apply is attributed to the authenticated administrator who made the request.
- A local `cairncms config apply` run is attributed to the system, with no user and an origin of `config-cli`.

Apply action hooks run after commit. Extension authors should follow the [handler context rules](/docs/develop/extensions/server-extensions/hooks/#the-context).

A mutating apply clears the system and response caches regardless of `CACHE_AUTO_PURGE`.

If a post-commit step fails, the configuration remains applied. `CONFIG_POST_COMMIT_FAILED` (HTTP `500`, CLI exit `3`) returns `extensions.committed: true` and identifies the failed step in `extensions.phase`:

- **`cache`** — clear the cache with `POST /utils/cache/clear`; re-running a now-empty apply will not clear it.
- **`actions`** — some post-commit hooks or flows may not have run; no cache action is needed.
- **`cache_and_actions`** — clear the cache and treat the events as possibly undelivered.

### Run record

Plans and applies produce a structured `config.run.finished` log record, including dry runs and refusals. Logging is best-effort, so a missing record does not prove the apply never ran. For example:

```json
{"event":"config.run.finished","runId":"3f6c1b0e-9b2c-4a1d-8f2e-0a7d5c4b3e21","source":"http","caller":{"kind":"user","user":"<uuid>","role":"<uuid>"},"userAgent":"cairncms-cli/1.6.0","dryRun":false,"destructive":true,"manifestVersion":2,"managedKinds":["roles","permissions","folders"],"changes":{"create":1,"update":2,"delete":1},"result":"applied","durationMs":184,"msg":"Config run finished"}
```

- **`result`** — `no_changes`, `planned`, `discarded`, `refused`, `invalid`, `state_changed`, `applied`, `post_apply_failed`, or `failed`. `planned` has dry-run changes, `discarded` was declined at the prompt, and `post_apply_failed` means the configuration was applied before cache invalidation or event delivery failed.
- **`errorCode`** — present for `refused`, `invalid`, `state_changed`, `failed`, and `post_apply_failed`: the typed error code, such as `DESTRUCTIVE_CHANGES_REQUIRED`, or `UNEXPECTED` for an error outside the config error set.
- **`source`** — `cli` for a local `config apply`, `http` for `POST /config/apply`, including runs driven by the remote CLI, whose `userAgent` starts with `cairncms-cli/`.
- **`caller`** — the administrator's user and role ids on an HTTP run, or the system actor with origin `config-cli` on a local run.
- **`changes`** — the plan's create, update, and delete counts.
- **`durationMs`** — time spent planning and applying, excluding transport time.

The server writes these records at `info` level. For local CLI runs in CI, set `LOG_STYLE=raw` to receive them as JSON lines. A failure before a run starts, such as a rejected request body, produces no run record, while a validation failure inside a started run is recorded with an `invalid` result.

Use the HTTP response's `X-Config-Run-Id` header to find the matching server record. The remote CLI prints it as `Run <id>`. Requests rejected before a run starts have no run id. Local CLI runs have no run id either.

## Field semantics

When editing the files or an HTTP snapshot:

- **Omitted optional role fields are preserved.** If a role payload omits `icon`, `description`, `enforce_tfa`, or `ip_access`, the database value is left unchanged.
- **Clear a role's `description` or `ip_access` with `null`.** Other role fields do not accept `null`.
- **Folder parents use keys.** Set `parent` to another folder's key from the same config to place the folder under it. Set it to `null` to move the folder to the top level. Omitting `parent` preserves the folder's current parent, and a new folder with no `parent` is created at the top level. Include `key` and `name` in every folder document.
- **Omitted settings fields remain unchanged in the target database.** `project_name` and `default_language` cannot be `null`.
- **Set the default storage folder by key.** Use a folder key for `storage_default_folder`, or `null` to clear the default. If `folders` is listed in `resources`, include the folder in the config. Otherwise, it must already exist in the target database.

To rename or move a folder, edit its `name` or `parent` and keep its `key`. Generated snapshots include all supported fields.

### Extension settings

Each subject's file has a `global` map and a `collections` map. Put global settings under `global.<key>` and collection-scoped settings under `collections.<collection>.<key>`. The extension's declaration determines each key's scope, type, and secret source.

Values take three forms:

- **Ordinary values** are strings, numbers, or booleans. Ordinary strings may use a whole-value `{{CAIRNCMS_CONFIG_*}}` placeholder with the CLI.
- **Inline secrets** use `{ $secret: preserve }`. A snapshot emits this marker for a stored secret, and an apply leaves the target's value unchanged.
- **Config-sourced secrets** use the exact `{{CAIRNCMS_EXT_*}}` reference emitted by the snapshot. Set the corresponding environment variable on the target server. These secrets are read from the environment at runtime and are never stored or deleted by config apply.

Config apply does not supply inline secret values. Set or rotate them in the admin app or through the admin API as a separate instance-setup step. `$secret: preserve` also succeeds when the target has no value, leaving it unset. Functionality that requires that secret remains unavailable until it is supplied. The extension author chooses the [secret source](/docs/develop/extensions/settings/#secret-settings), and the config file cannot change it.

For a subject with a file, an apply clears stored values for currently declared target keys absent from that file, including inline secrets and keys that exist only on the target. Omitting the `global` or `collections` map means an empty desired set for that map. These deletions are shown in the plan and require `--destructive`.

To clear all currently declared stored values for a subject, including its inline secrets, keep its generated file and use empty maps:

```yaml
subject: cairncms-extension-chat-notify
global: {}
collections: {}
```

Review the deletion plan before applying with `--destructive`. A blank file or `{}` is invalid because `subject` is required. Removing the file entirely stops managing that subject and preserves its stored values.

Rows left behind by uninstalled or ineligible extensions, and stored keys an extension no longer declares, remain untouched. Config-sourced references are also unaffected by clearing stored values.

### Supported fields

Unknown fields stop the apply. Fields outside the config format are not exported or updated, but are removed with their record if it is deleted.

## Validation

Both surfaces validate the configuration and plan before applying changes. Role and folder references must resolve as described in [Managed scope](#managed-scope) and [Field semantics](#field-semantics). A settings default folder must reference a folder the config declares when folders are managed, or one already in the database when they are not. Each role can have only one permission rule per collection and action.

Every named extension subject must be installed on the target with an available settings declaration, even in a document with empty maps. Each setting key must be declared with the matching type and scope, and collection-scoped settings must name an existing collection. Inline secrets accept only the preserve marker, and config-sourced secrets require their exact runtime reference.

Every step must retain at least one role with `admin_access: true`. Plans that cannot do so report `ADMIN_CONTINUITY_REQUIRED`; `--destructive` does not override this protection.

### Error responses

Validation failures and refusals make no changes. A failed apply transaction is rolled back. The HTTP API reports errors in an `errors` array:

```json
{
  "errors": [
    {
      "message": "Permission set references role \"editor\", which does not exist in the database.",
      "extensions": { "code": "CONFIG_INVALID" }
    }
  ]
}
```

Config-specific HTTP codes are:

- **`CONFIG_INVALID`** (400) — invalid configuration. The message identifies the field or reference to correct.
- **`CONFIG_UNSUPPORTED_VERSION`** (400) — the manifest version is unsupported or does not support a listed kind.
- **`CONFIG_IDENTITY_CONFLICT`** (400) — a duplicate role key, folder key, permission identity, or extension-settings subject.
- **`CONFIG_PROTECTED_RECORD`** (400) — the plan would break administrator continuity.
- **`DESTRUCTIVE_CHANGES_REQUIRED`** (400) — a plan contains deletions that were not authorized. `extensions.deletions` lists the identities.
- **`CONFIG_FOLDER_IN_USE`** (400) — a folder still has contents or references. `extensions.blockedBy` identifies what must be moved or cleared before deletion.
- **`CONFIG_STATE_CHANGED`** (409) — required state changed or a conflicting write prevented the apply. Review a fresh plan and retry.
- **`CONFIG_READ_FAILED`** (500) — required database state is unreadable, such as an orphaned or duplicate permission row.
- **`CONFIG_APPLY_FAILED`** (500) — the apply transaction failed and was rolled back.

Malformed JSON uses `INVALID_PAYLOAD`. Unsupported content types use `UNSUPPORTED_MEDIA_TYPE`.

The CLI writes failure messages to standard error and uses the [exit codes](#exit-codes) above. An unset `CAIRNCMS_CONFIG_*` placeholder is reported as `CONFIG_PLACEHOLDER_UNRESOLVED`. In a role or project-setting field, an interpolation placeholder outside that namespace is `CONFIG_INVALID`. In an ordinary extension-setting string, a placeholder outside that namespace is kept as a literal value. Declared `CAIRNCMS_EXT_*` runtime references are carried without interpolation.

### Repairing an unreadable extension setting

A change to an extension's declaration can leave a currently declared stored value incompatible with its new type or scope, which a snapshot or apply reports as `CONFIG_READ_FAILED`. The message identifies the setting.

If the value is still stored under the correct identity, correct it through the Studio settings screen or by sending the corrected value to `POST /extension-settings` with `{ subject, scope, scope_key, key, value }`, then snapshot again.

If the stored row now has an obsolete scope or targets a collection that no longer exists, remove that exact row with `DELETE /extension-settings` and a body of `{ subject, scope, scope_key, key }`, then snapshot again. Re-saving the value under its new identity does not remove the stale row, and config apply never deletes it for you. Both endpoints require an administrator token.

## Source-control workflow

For a multi-environment project:

1. Make role, permission, folder, project-settings, or extension-settings changes in your development instance using the corresponding admin screens.
2. Run `cairncms config snapshot ./config` to write the directory tree.
3. Review and commit the snapshot diff.
4. Run `cairncms config apply --dry-run --format json ./config` against staging. Exit `1` means changes are planned. After review, apply them with `cairncms config apply --yes ./config`.
5. Production deploys the same way, after staging verification.

For deletions, review the dry-run output before merging and add `--destructive` to the apply command.

## Pairing with schema-as-code

When promoting changes between environments, apply schema first, then config:

```bash
cairncms schema apply ./schema.yaml
cairncms config apply ./config
```

Apply schema before config so referenced collections exist when permissions and collection-scoped extension settings are installed. Config apply reports missing permission collections as warnings. A missing collection for an extension setting stops the apply.

Applying an unchanged schema or config is a no-op, so both commands can run on every deployment.

## Where to go next

- [Schema as code](/docs/manage/schema-as-code/) — the same pattern for collections, fields, and relations.
- [Migration between instances](/docs/manage/migration-between-instances/) — moving full deployments, of which a config snapshot is one piece.
- [Permissions](/docs/guides/permissions/) — the conceptual model behind what config-as-code captures.
