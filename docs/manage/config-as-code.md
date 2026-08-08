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
5. If the plan is empty, log `No changes to apply` and exit.
6. Print the plan summary, prompt for confirmation, then apply.

Three flags adjust the flow:

- **`--dry-run`** — compute and print the plan without writing. Pairs with `--format json` for machine-readable output. Exits with code `1` if the plan is non-empty, which makes drift detection clean to gate in CI.
- **`--yes`** — skip the confirmation prompt.
- **`--destructive`** — opt in to deleting roles and permissions that exist in the database but are absent from the config directory. Off by default so accidental omissions do not silently delete state.

The destructive flag is the one that makes orphan removal possible. Without it, an apply only creates and updates while orphans in the database remain. This is the safer default for environments where the config directory might not represent the full intended state.

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

- **`?dry_run=true`** — compute and return the plan without writing. The response shape is identical to a real apply; only the database is left unchanged.
- **`?destructive=true`** — required for the apply to delete orphans. Without it, only creates and updates run.

The response is a summary of what changed (or would have changed for a dry run):

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

Roles are tracked by key in the response; permissions are tracked as counts because per-rule attribution does not produce useful operator output at scale.

### No diff endpoint

Schema-as-code uses a two-step `/schema/diff` then `/schema/apply` flow with a hash handoff to detect concurrent changes. Config-as-code does not. The apply endpoint computes the plan internally on every call because the config payload is much smaller than a typical schema, the engine is fast enough that the plan/apply round-trip in a single call is comfortable, and the dry-run flag covers the same "what would change?" use case without requiring a stateful client.

If you need to inspect the plan before applying, use `?dry_run=true` and read the response.

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
- **Last admin role protection** — an apply that would leave the deployment with no role flagged as `admin_access: true` is rejected. There is no override and no special "Administrator" entity. The protection is purely about the flag, on whatever roles carry it.
- **Undefined role references** — a permission set whose `role` cannot be resolved is rejected, identically on both surfaces. When the config manages roles, the role must be declared in the config. When it does not, the role must already exist in the database (see [Managed scope](#managed-scope)).
- **Duplicate permission tuples** — two rules in the same role's set targeting the same `(collection, action)` are rejected. Permissions must be unique on that tuple.
- **Reserved key misuse** — the `public` key in `roles[]` is rejected. The Public role record is platform-managed and cannot be created or updated as a role definition. The same `public` key in `permissions[]` is the supported way to manage Public access.

Validation failures are reported without applying changes.

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

The order matters: permissions reference collections, so the collections have to exist before the permissions that gate them can be applied. Reversing the order produces undefined-collection validation failures.

Both surfaces tolerate empty diffs gracefully by applying an unchanged schema or config is a no-op that exits cleanly. Running both in a deploy pipeline as a matter of course, even when only one has changed, is safe and removes the cognitive load of remembering which one to run when.

## Where to go next

- [Schema as code](/docs/manage/schema-as-code/) — the same pattern for collections, fields, and relations.
- [Migration between instances](/docs/manage/migration-between-instances/) — moving full deployments, of which a config snapshot is one piece.
- [Permissions](/docs/guides/permissions/) — the conceptual model behind what config-as-code captures.
