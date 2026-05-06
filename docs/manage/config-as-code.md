---
title: Config as code
description: Capture roles and permissions to versioned files, review them as a diff, and apply them across environments — through the CLI or the HTTP API.
sidebar:
  order: 8
---

CairnCMS treats roles and permissions as state that lives next to your data model that can be captured to a file, reviewed as a diff, and applied to other environments. The same machinery powers two surfaces: a `cairncms config` CLI that operates on a directory tree, and a `/config/*` HTTP API that operates on a single JSON or YAML payload. Both flow through the same plan/apply engine, with one structural difference at the input layer — see [Two surfaces, one engine](#two-surfaces-one-engine) below.

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

Use config-as-code for the access-control side of the model. Use schema-as-code for structure. Use database backups for the actual user data.

## Two surfaces, one engine

The CLI and the HTTP API share the same plan/apply engine but differ in how they consume input:

| | CLI | HTTP API |
|---|---|---|
| Format | Directory tree | Single flat payload |
| Source format | YAML files | YAML or JSON |
| Invocation | Local `cairncms` binary | Bearer-authed HTTP |
| Safety | Interactive confirmation | Opt-in query flags |

The CLI suits local development and GitOps pipelines where the directory tree is committed to source control and applied by a runner that has container access. The HTTP API suits remote instances behind a load balancer, automation that lives outside the container, and tooling in any language.

The two are mostly substitutable. Using snapshot via one, and apply via the other works in practice with one structural divergence at the input layer:

- **The CLI directory reader is strict about role/permission file pairing.** A `permissions/<key>.yaml` whose role does not have a matching `roles/<key>.yaml` (other than the reserved `public`) is rejected at read time.
- **The HTTP apply path is permissive in the same situation.** A permission set whose `role` is omitted from `roles[]` in the payload is allowed if a role with that key already exists in the database. This makes payloads that only update permissions without re-stating roles a working pattern over HTTP.

Both behaviors are intentional: the CLI surface is opinionated about the directory shape it reads, while the HTTP surface accepts narrower payloads that target an already-bootstrapped database. If you need consistent validation across both, run `--dry-run` against the directory tree before posting any narrowed payload to HTTP.

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

The split is deliberate: per-role changes show up as small, scoped diffs in source control rather than one giant file every time anyone touches a permission.

### Apply

Read a config directory and reconcile the database to it:

```bash
cairncms config apply ./config
```

The flow:

1. Load the directory tree into a single payload.
2. Read the current database state and compute a plan (creates, updates, deletes).
3. Validate the plan (manifest version, last-admin-role protection, undefined-role references, duplicate permission tuples).
4. If the plan is empty, log `No changes to apply` and exit.
5. Print the plan summary, prompt for confirmation, then apply.

Three flags adjust the flow:

- **`--dry-run`** — compute and print the plan without writing. Pairs with `--format json` for machine-readable output. Exits with code `1` if the plan is non-empty, which makes drift detection clean to gate in CI.
- **`--yes`** — skip the confirmation prompt.
- **`--destructive`** — opt in to deleting roles and permissions that exist in the database but are absent from the config directory. Off by default so accidental omissions do not silently delete state.

The destructive flag is the one that makes orphan removal possible. Without it, an apply only creates and updates while orphans in the database remain. This is the safer default for environments where the config directory might not represent the full intended state.

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

- **Omitted optional role fields are preserved, not cleared.** If a role payload omits `icon`, `description`, or `enforce_tfa`, the database value is left untouched.
- **Explicitly null fields are cleared.** To unset a nullable field like `description`, `ip_access`, and others, set it to `null` in the payload.

This matches the schema-as-code semantic: the snapshot describes the desired state of the fields it mentions, not the desired state of every field.

## Validation

Before applying, the engine validates the plan and rejects the entire apply if any check fails. The validation surface:

- **Manifest version** — only versions the engine recognizes are accepted. Future-format payloads are rejected rather than partially applied.
- **Last admin role protection** — an apply that would leave the deployment with no role flagged as `admin_access: true` is rejected. There is no override and no special "Administrator" entity. The protection is purely about the flag, on whatever roles carry it.
- **Undefined role references** — a permission set whose `role` is missing from both the payload's `roles[]` and the existing database is rejected. The HTTP path tolerates references to roles that exist in the database but are absent from the payload; the CLI rejects them at directory-read time before the engine sees them.
- **Duplicate permission tuples** — two rules in the same role's set targeting the same `(collection, action)` are rejected. Permissions must be unique on that tuple.
- **Reserved key misuse** — the `public` key in `roles[]` is rejected. The Public role record is platform-managed and cannot be created or updated as a role definition. The same `public` key in `permissions[]` is the supported way to manage Public access.

When validation fails, the API returns a 400 with a flat `errors` array of human-readable messages so all failures surface in one response. The CLI prints the messages and exits with a distinct code (`2`) so CI can distinguish validation failures from connection failures or runtime errors.

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
