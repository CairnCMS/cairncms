---
title: Config as code
description: Capture roles, permissions, and folders to versioned files, review changes, and apply them across environments.
sidebar:
  order: 8
---

Use config-as-code to capture roles, permissions, and folders, review changes in source control, and apply them across environments. Use the CLI for a directory of YAML files or the HTTP API for a single JSON or YAML document.

## What a config snapshot captures

A snapshot contains:

- **Roles** — every operator-managed role with its key, name, icon, description, access flags, and `enforce_tfa` setting.
- **Permissions** — the operator-defined rules attached to each role, grouped by role. Each permission rule includes the collection, action, field allow-list, item-level filter, validation, and presets.
- **Folders** — the file-library folder names and hierarchy. File contents are not included.

It does not contain:

- **Schema.** Collections, fields, and relations belong to [schema-as-code](/docs/manage/schema-as-code/) and ship in a separate snapshot.
- **Users and content.** Account records, collection items, uploaded files, and their metadata require a separate migration or backup.
- **The Public role record.** Public access is managed through `permissions/public.yaml`. There is no `roles/public.yaml`.
- **System-managed permissions.** Built-in rules, such as those supplied by `app_access: true`, are provided automatically by CairnCMS.

## Managed scope

The `resources` list in `cairncms-config.yaml` selects what to manage:

```yaml
version: 2
resources:
  - roles
  - permissions
  - folders
```

Within each listed kind, the files describe the complete desired set. Records absent from that set are planned for deletion. Omitted kinds are left alone, and `resources: []` manages nothing.

Re-snapshotting an existing directory preserves its version and scope. Version 1 supports roles and permissions. Version 2 adds folders. To adopt folders in an existing project, set `version: 2`, add `folders` to `resources`, then re-snapshot the source instance and review the files before applying elsewhere.

Roles and permissions can be managed independently. When both are managed, each permission set must reference a role declared in the config. When only permissions are managed, role references resolve against roles already in the target database.

Roles and folders are matched across environments by their keys. Keys remain unchanged when records are renamed or folders are moved. Preserve the keys in your snapshots so subsequent applies update the existing records.

Deleting a role also deletes its permissions and presets, and suspends and unassigns its users, even when those resources are outside the manifest's scope. Review the dry-run output before authorizing deletions.

Unlike [deleting a folder in the app](/docs/guides/files/#renaming-moving-and-deleting-folders), config apply does not relocate its contents. Before deleting a folder, move its files and clear or replace any settings or field references to it. Child folders must be moved or deleted, which can be part of the same config apply. If any of these remain at deletion time, the entire apply is refused with `CONFIG_FOLDER_IN_USE`. A dry run lists the blockers observed for each folder it would delete, and the apply checks again at deletion time.

## Two surfaces, one engine

Choose the surface that fits your deployment:

| | CLI | HTTP API |
|---|---|---|
| Input | Directory of YAML files | Single YAML or JSON document |
| Target | Local database or remote server with `--url` | Remote server with an admin token |
| Safety | Interactive confirmation | Opt-in query flags |

Both produce the same plans and apply the same scope rules. The CLI also requires filenames to match record identities: `roles/editor.yaml` must declare `key: editor`, and `folders/reports.yaml` must declare `key: reports`.

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
└── folders/
    ├── documents.yaml           # one file per folder, named after folder.key
    └── reports.yaml
```

For example, `folders/reports.yaml` places Reports under the folder whose key is `documents`:

```yaml
key: reports
name: Reports
parent: documents
```

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
- **`--destructive`** — authorize deleting managed roles, permissions, or folders that are absent from the config. Off by default.

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

Plan: 1 to create, 1 to update, 1 to delete.
```

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
    }
  ],
  "summary": { "create": 0, "update": 1, "delete": 1 },
  "warnings": [],
  "protections": []
}
```

`planVersion` identifies the output format, independently of the input's `manifestVersion`. Each change has a `kind`, `operation`, and `identity`. Creates include `values`, updates include `before`/`after` fields, and role deletions include their cascading `impact`. An empty plan has a zeroed `summary`.

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

Role names and descriptions accept environment placeholders such as `{{CAIRNCMS_CONFIG_EDITOR_NAME}}`. The placeholder must occupy the entire field value. The CLI resolves it before planning. Unset variables or names outside the `CAIRNCMS_CONFIG_` namespace stop the command. Folder fields do not support interpolation.

The HTTP API does not resolve placeholders. Send resolved values in the request body.

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
  }
}
```

The response includes the plan under `meta.plan`. A dry run instead returns the [plan document](#machine-readable-output) under `data`.

A plan containing deletions requires `?destructive=true`. Otherwise, nothing is applied and the response is `400 DESTRUCTIVE_CHANGES_REQUIRED`, with the planned deletions in `extensions.deletions`.

Administrator-continuity protection returns `400 CONFIG_PROTECTED_RECORD`, even with `?destructive=true`. Its `extensions.protection.code` is `ADMIN_CONTINUITY_REQUIRED`. A dry run returns `200` with this entry in `protections` so automation can detect it before applying.

### No diff endpoint

Use `POST /config/apply?dry_run=true` to preview changes. Each apply computes a fresh plan; it does not reuse a previous dry run. If required state changes between planning and the pre-write check, the apply is refused with `409 CONFIG_STATE_CHANGED`. Review a fresh plan before retrying.

## Audit records and events

Config applies use the normal activity and revision tracking for each affected collection, including changes caused by a role deletion.

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
- **Folder parents use keys.** Set `parent` to another folder's key from the same config. Set it to `null`, or omit it, to place the folder at the top level. Include `key` and `name` in every folder document.

To rename or move a folder, edit its `name` or `parent` and keep its `key`. Generated snapshots include all supported fields.

### Supported fields

Unknown fields stop the apply. Fields outside the config format are not exported or updated, but are removed with their record if it is deleted.

## Validation

Both surfaces validate the configuration and plan before applying changes. Role and folder references must resolve as described in [Managed scope](#managed-scope) and [Field semantics](#field-semantics). Each role can have only one permission rule per collection and action.

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
- **`CONFIG_IDENTITY_CONFLICT`** (400) — a duplicate role key, folder key, or permission identity.
- **`CONFIG_PROTECTED_RECORD`** (400) — the plan would break administrator continuity.
- **`DESTRUCTIVE_CHANGES_REQUIRED`** (400) — a plan contains deletions that were not authorized. `extensions.deletions` lists the identities.
- **`CONFIG_FOLDER_IN_USE`** (400) — a folder still has contents or references. `extensions.blockedBy` identifies what must be moved or cleared before deletion.
- **`CONFIG_STATE_CHANGED`** (409) — required state changed or a conflicting write prevented the apply. Review a fresh plan and retry.
- **`CONFIG_READ_FAILED`** (500) — required database state is unreadable, such as an orphaned or duplicate permission row.
- **`CONFIG_APPLY_FAILED`** (500) — the apply transaction failed and was rolled back.

Malformed JSON uses `INVALID_PAYLOAD`. Unsupported content types use `UNSUPPORTED_MEDIA_TYPE`.

The CLI writes failure messages to standard error and uses the [exit codes](#exit-codes) above. An unset `CAIRNCMS_CONFIG_*` placeholder is reported as `CONFIG_PLACEHOLDER_UNRESOLVED`. A placeholder outside that namespace is `CONFIG_INVALID`.

## Source-control workflow

For a multi-environment project:

1. Make role, permission, or folder changes in your development instance using Settings → Access Control or the File library.
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

Apply schema before config so referenced collections exist when permissions are installed. Config apply does not reject permissions for missing collections, but the plan reports them as warnings.

Applying an unchanged schema or config is a no-op, so both commands can run on every deployment.

## Where to go next

- [Schema as code](/docs/manage/schema-as-code/) — the same pattern for collections, fields, and relations.
- [Migration between instances](/docs/manage/migration-between-instances/) — moving full deployments, of which a config snapshot is one piece.
- [Permissions](/docs/guides/permissions/) — the conceptual model behind what config-as-code captures.
