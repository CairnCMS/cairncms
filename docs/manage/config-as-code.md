---
title: Config as code
description: Capture roles and permissions to versioned files, review them as a diff, and apply them across environments — through the CLI or the HTTP API.
sidebar:
  order: 8
---

CairnCMS treats project configuration, including roles and permissions, as state that can be captured in files, reviewed as a diff, and applied to another instance. The CLI reads a directory tree, while the HTTP API reads a single JSON or YAML document. Both feed the same planning and apply engine.

This page covers what config-as-code captures, the CLI workflow, the HTTP equivalent, and the operator practices that make the two work together.

## What a config snapshot captures

A snapshot contains:

- **Roles** — every operator-managed role with its key, name, icon, description, access flags, and `enforce_tfa` setting.
- **Permissions** — the operator-defined rules attached to each role, grouped by role. Each permission rule includes the collection, action, field allow-list, item-level filter, validation, and presets.

It does not contain:

- **Schema.** Collections, fields, and relations belong to [schema-as-code](/docs/manage/schema-as-code/) and ship in a separate snapshot.
- **Users.** Account records, passwords, and personal data are intentionally out of scope.
- **The Public role record.** The platform-managed Public role is not exported as a role definition in that there is no `roles/public.yaml` and the role row itself is excluded from the snapshot's `roles[]`. Its permissions are still captured and applied through `permissions/public.yaml` (under the reserved key `public`), so editing Public access in the app and re-snapshotting produces the expected diff.
- **System-managed permissions.** Some permissions are platform-managed and flagged as system-owned (the app-access minimum and recommended permissions that surface for any role with `app_access: true`, for example). These are projected from in-memory constants at read time rather than stored as ordinary rows, and the snapshot deliberately skips them. They are managed by the platform, not by config-as-code, and reappear automatically wherever a role's access flags require them.

Roles with `admin_access: true` are captured like any other role, but the engine refuses applies that would leave the deployment with no role flagged as `admin_access: true` — see [Validation](#validation) below.

Use schema-as-code for collections, fields, and relations. Use database backups for content and user data.

## Managed scope

The `resources` list in `cairncms-config.yaml` defines which resource kinds the config manages. CairnCMS reconciles only the listed kinds. An empty list manages nothing. When snapshotting into an existing directory, the CLI preserves the manifest's scope. Change the manifest explicitly to start or stop managing a kind.

Roles and permissions can be managed independently. When both are managed, each permission set must reference a role declared in the config. When only permissions are managed, role references resolve against roles already in the target database.

Deleting a managed role still runs the platform's normal role-deletion cascade. Its permissions and presets are deleted, and users assigned to it are suspended and unassigned, even when those related resources are not managed by the manifest. Review the dry-run output before applying a deletion.

## Two surfaces, one engine

The CLI and the HTTP API share the same plan/apply engine but differ in how they consume input:

| | CLI | HTTP API |
|---|---|---|
| Format | Directory tree | Single document |
| Source format | YAML files | YAML or JSON |
| Invocation | Local `cairncms` binary | Bearer-authed HTTP |
| Safety | Interactive confirmation | Opt-in query flags |

The CLI suits local development and GitOps pipelines where the directory tree is committed to source control and applied by a runner that has container access. The HTTP API suits remote instances behind a load balancer, automation that lives outside the container, and tooling in any language.

After loading input, both surfaces interpret managed scope and compute and apply changes the same way. The CLI also checks that each filename matches the identity declared by its record. For example, `roles/editor.yaml` must declare `key: editor`. HTTP payloads have no filenames, so this check does not apply.

## The CLI

### Snapshot

Read the current roles and permissions and write them as a directory tree:

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
└── permissions/
    ├── editor.yaml               # one file per role's permissions
    └── public.yaml               # public role's permissions (no roles/public.yaml)
```

Snapshot treats any record file whose filename and declared identity match as managed, including hand-authored files. It leaves other files unchanged during cleanup.

Files and directories that CairnCMS reads or writes may use symlinks whose targets remain inside the config directory. Snapshot writes through contained symlinks and preserves them. When a stale record is a symlink, snapshot removes the link without deleting its target. Dangling links, targets outside the config directory, and targets that are not regular files or directories stop the command.

### Apply

Read a config directory and reconcile the database to it:

```bash
cairncms config apply ./config
```

The flow:

1. Load the directory tree.
2. Read the required current database state.
3. Validate the desired config.
4. Compute and validate the plan.
5. If the plan is empty, report any warnings and exit `0`. Human output prints `No changes to apply.` JSON output emits the complete plan document with a zeroed summary.
6. Print the complete plan. For a mutating apply, refuse the operation without changing anything if the plan contains deletions and `--destructive` was not passed.
7. Otherwise prompt for confirmation, then apply.

Three flags adjust the flow:

- **`--dry-run`** — compute and print the plan without writing. Exits `1` when the plan contains changes and `0` when it is empty, which supports CI drift checks. Add `--format json` for the machine-readable plan. JSON is only available with `--dry-run`.
- **`--yes`** — skip the confirmation prompt.
- **`--destructive`** — authorize deleting roles and permissions that exist in the database but are absent from the config. Off by default.

Deletions require explicit authorization. Without `--destructive`, a mutating apply whose plan contains deletions is refused and makes no changes, printing the deletions it would have made:

```
Apply refused: this plan contains 1 deletion.
Review the item above and run again with --destructive.
```

Pass `--destructive` to authorize the displayed deletions.

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
  "manifestVersion": 1,
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

`planVersion` identifies the payload format. Each change carries its `kind`, `operation`, and stable `identity`. A create carries the full canonical `values`, an update carries a per-field `before`/`after` map, and a role deletion carries an `impact` array describing the cascade. An empty plan still emits the complete document with a zeroed `summary`.

`protections` identifies valid plans that CairnCMS cannot apply safely. Each entry includes a stable `code` for automation, a human-readable `message`, and the contributing changes (`kind`, `operation`, and `identity`). If the array is not empty, CairnCMS refuses the apply even with `--destructive`. Automation should branch on `code`, not `message`.

The only protection currently defined is `ADMIN_CONTINUITY_REQUIRED`. CairnCMS applies creates first, role updates in config order, and deletions last. Every step must leave at least one role with `admin_access: true`. Create a replacement administrator or place its promotion before the demotion that would otherwise remove the final administrator.

Consumers of `planVersion: 2` must ignore unknown properties, but reject an unknown `planVersion`, `kind`, or `operation`. An unfamiliar protection still blocks the apply, and an unfamiliar warning remains a warning. Additive fields do not change `planVersion`; breaking changes do. The input format's strictly validated `manifest.version` is independent of the plan version.

### Exit codes

Both config commands map their outcome to an exit code, so a pipeline can branch on the result without parsing output:

`config apply`:

| Outcome | Code |
|---|---|
| Empty plan, or a successful apply, or a declined confirmation, or `--help` | 0 |
| Dry run whose plan contains changes | 1 |
| Validation failure, a deletion requiring `--destructive`, a protected apply (administrator continuity), or a usage error (unknown option, missing path, unknown `--format`, JSON without `--dry-run`) | 2 |
| No database connection, system tables not installed, unreadable state, or an unexpected failure | 3 |

`config snapshot`:

| Outcome | Code |
|---|---|
| Snapshot written, a declined overwrite, or `--help` | 0 |
| Usage error, or an invalid existing tree | 2 |
| No database connection, system tables not installed, unreadable state, or an unexpected failure | 3 |

Exit `1` indicates drift. Exit `2` indicates invalid input, invalid command usage, or a refused destructive apply. Exit `3` indicates an operational or unexpected runtime failure.

### Environment variables

Fields that support interpolation accept a placeholder in the form `{{CAIRNCMS_CONFIG_<NAME>}}`. The placeholder must occupy the entire field value. The CLI reads the value from its environment before it builds a plan. A variable outside the `CAIRNCMS_CONFIG_` namespace or a variable that is not set stops the command.

The HTTP API does not resolve placeholders. Send resolved values in the request body.

## The HTTP API

The same workflow over HTTP, restricted to admin tokens.

### Retrieve a snapshot

```
GET /config/snapshot
GET /config/snapshot?export=yaml
```

Returns the current roles and permissions as a JSON payload, or as a YAML attachment when `?export=yaml` is set. The `data` envelope wraps the payload the same way every other CairnCMS API response does. The endpoint opts out of response caching, so subsequent calls always reflect the current database state.

### Apply

```
POST /config/apply
POST /config/apply?dry_run=true
POST /config/apply?destructive=true
```

Send a `CairnConfig` payload — the same shape as the `data` field returned by `/config/snapshot`, without the outer envelope. The server accepts:

- `application/json`
- `application/yaml`, `application/x-yaml`, or `text/yaml`

The YAML media types support a natural round-trip: fetch as YAML, edit, post the same YAML back.

Two query flags shape the apply:

- **`?dry_run=true`** — compute and return the plan without writing. The response is the plan document, not an apply summary.
- **`?destructive=true`** — authorize deletions during a mutating apply. Dry runs always return the complete plan.

A mutating apply returns a summary of what changed:

```json
{
  "data": {
    "roles": {
      "created": ["editor"],
      "updated": ["administrator"],
      "deleted": []
    },
    "permissions": {
      "created": 5,
      "updated": 3,
      "deleted": 0
    }
  }
}
```

Mutating applies return role keys and permission counts.

A dry run returns the same plan document the CLI prints with `--dry-run --format json`, under the standard `data` envelope.

A mutating apply whose plan contains a deletion without `?destructive=true` is refused with a `400` and the `DESTRUCTIVE_CHANGES_REQUIRED` code. The error's `extensions.deletions` lists the identities that would be deleted, and nothing is applied. Re-send with `?destructive=true` to authorize them.

A mutating apply is refused if any create, role update, or deletion step would remove the final role with `admin_access: true`. The response is a `400` with the `CONFIG_PROTECTED_RECORD` code, even when `?destructive=true`. Its `extensions.protection.code` is `ADMIN_CONTINUITY_REQUIRED`, and `extensions.contributors` identifies the role removals by `kind`, `operation`, and `identity`. A dry run returns `200` with the same entry in `protections`, allowing a pipeline to detect the block before applying.

### No diff endpoint

Schema-as-code uses a two-step `/schema/diff` then `/schema/apply` flow with a client-held hash handoff. Config-as-code keeps a single-call apply. The config payload is much smaller than a typical schema, the engine computes the plan internally on every call, and the dry-run flag covers the same "what would change?" use case without a stateful client.

A single-call apply is still protected against a concurrent change. The apply hashes the current state its plan was read from, then re-reads and re-hashes that state inside the apply transaction before making any change. If the managed records or the role identities the plan depends on changed in between, the apply makes no change and returns `CONFIG_STATE_CHANGED` (409). Recompute the plan and re-apply. A plan with no changes has nothing to write, so it applies without the recheck.

If you need to inspect the plan before applying, use `?dry_run=true` and read the response.

## Audit records and events

A mutating apply records the same audit trail as any other mutation, following each collection's native accountability setting. Creating or updating a role or permission records an activity entry and a revision. Deleting one records an activity entry only. A role deletion's cascade records its own consequences the same way, so suspending a user records activity and a revision, while removing a role-scoped preset records nothing because presets are not accountability-tracked.

Applies are attributed:

- An HTTP apply is attributed to the authenticated administrator who made the request.
- A local `cairncms config apply` run is attributed to the system actor, recorded with no user and an origin of `config-cli`, so an automated local apply is distinguishable from an administrator's request.

Domain action events such as `roles.create` and `permissions.delete` are emitted once, after the transaction commits, so an extension hook is never told about a change that a rollback later undoes, and no event is emitted for an apply that rolls back.

If cache invalidation fails after the transaction has committed, the apply is not rolled back. The configuration is already applied and its events are delivered. The failure is reported separately as `CONFIG_POST_COMMIT_FAILED` (HTTP `500`, CLI exit `3`). Its `extensions.committed` is `true` and its `extensions.phase` is `cache`, so a client can tell the configuration was applied even though the cache was not cleared. Clear the cache with `POST /utils/cache/clear` to recover, since re-running the apply may produce an empty plan and will not clear the cache on its own.

## Field semantics

Both CLI and API follow the same omit-versus-null rule:

- **Omitted optional role fields are preserved.** If a role payload omits `icon`, `description`, `enforce_tfa`, or `ip_access`, the database value is left unchanged.
- **Explicitly null fields are cleared.** Only `description` and `ip_access` accept `null`.

An apply changes only the fields present in the declaration. Generated snapshots include the complete supported field set for reproducibility.

### Supported fields

Each resource kind accepts only the fields defined by its config format. Unknown fields stop the apply instead of being ignored.

Fields outside this contract are not exported or updated by config-as-code. They remain part of the database record and are removed if that record is deleted.

## Validation

After their input-specific checks, both surfaces validate the same config contract. The engine rejects the entire apply if either the desired config or the resulting plan fails validation. Validation includes:

- **Readable state** — an unreadable manifest, managed directory, config record, or current database value stops the run before a plan is created.
- **Supported document values** — config values must round-trip without changing meaning. Binary YAML values and non-finite numbers are rejected. Dates remain supported and normalize to ISO 8601 strings. Documents nested deeper than 100 levels or using more than 50 YAML aliases to mappings or sequences are outside the supported range.
- **Manifest version** — only versions the engine recognizes are accepted. Future-format payloads are rejected rather than partially applied.
- **Administrator continuity:** Every create, role update, and deletion step must leave at least one role with `admin_access: true`. Unsafe plans report `ADMIN_CONTINUITY_REQUIRED`, and `--destructive` cannot override the protection.
- **Undefined role references** — a permission set whose `role` cannot be resolved is rejected, identically on both surfaces. When the config manages roles, the role must be declared in the config. When it does not, the role must already exist in the database (see [Managed scope](#managed-scope)).
- **Duplicate permission tuples** — two rules in the same role's set targeting the same `(collection, action)` are rejected. Permissions must be unique on that tuple.
- **Reserved key misuse** — the `public` key in `roles[]` is rejected. The Public role record is platform-managed and cannot be created or updated as a role definition. The same `public` key in `permissions[]` is the supported way to manage Public access.

Validation failures are reported without applying changes.

### Error responses

Validation failures and refused destructive applies make no changes. If the apply transaction fails, CairnCMS rolls it back. When a validation pass reports more than one failure, the HTTP API returns one `errors` entry for each reported failure:

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

- **`CONFIG_INVALID`** (400) — invalid document structure, values, fields, role references, reserved keys, or placeholder syntax in HTTP input.
- **`CONFIG_UNSUPPORTED_VERSION`** (400) — an unsupported manifest version.
- **`CONFIG_IDENTITY_CONFLICT`** (400) — a duplicate role or permission identity.
- **`CONFIG_PROTECTED_RECORD`** (400) — a plan that would remove the last `admin_access: true` role.
- **`DESTRUCTIVE_CHANGES_REQUIRED`** (400) — a plan contains deletions that were not authorized. `extensions.deletions` lists the identities.
- **`CONFIG_STATE_CHANGED`** (409) — the managed state or a role identity the plan depended on changed between plan and apply, or a concurrent write forced a serialization conflict. The apply made no change. Recompute the plan and re-apply.
- **`CONFIG_READ_FAILED`** (500) — required database state could not be read.
- **`CONFIG_APPLY_FAILED`** (500) — the apply transaction failed and was rolled back.

Malformed JSON uses `INVALID_PAYLOAD`. Unsupported content types use `UNSUPPORTED_MEDIA_TYPE`.

The CLI writes failure messages to standard error and uses the [exit codes](#exit-codes) above. An unset `CAIRNCMS_CONFIG_*` placeholder is reported as `CONFIG_PLACEHOLDER_UNRESOLVED`. A placeholder outside that namespace is `CONFIG_INVALID`.

Config-as-code reads current state without running extension query filters, read filters, or read actions.

## Source-control workflow

The intended pattern for a multi-environment project mirrors schema-as-code:

1. Make role and permission changes in your dev instance (the app's Settings → Access Control surface is the easiest editor).
2. Run `cairncms config snapshot ./config` to write the directory tree.
3. Commit. The diff in the pull request shows scoped per-role changes.
4. CI runs `cairncms config apply --dry-run --format json ./config` against staging; if the exit code is `1`, the deploy step proceeds with `cairncms config apply --yes ./config`.
5. Production deploys the same way, after staging verification.

For destructive changes — removing a role, dropping permissions — pass `--destructive` and review the dry-run output carefully before merge. The destructive flag is intentionally a per-apply opt-in rather than a setting somewhere; cumulative defaults that quietly become destructive are how state gets deleted by accident.

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
