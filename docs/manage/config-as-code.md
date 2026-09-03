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

The CLI suits local development and GitOps pipelines where the directory tree is committed to source control and applied by a runner that has container access. The HTTP API suits remote instances behind a load balancer, automation that lives outside the container, and tooling in any language. The CLI can also drive a remote instance's HTTP surface directly with `--url`, keeping the directory workflow while targeting a server it does not share a container with (see [Applying to a remote instance](#applying-to-a-remote-instance)).

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

The only protection currently defined is `ADMIN_CONTINUITY_REQUIRED`. CairnCMS applies creates first, then role updates with administrator grants ahead of the rest, and deletions last. Every step must leave at least one role with `admin_access: true`. Because grants run first, handing administrator access from one role to another applies in a single run regardless of the order of the role files or the request body. A demotion that leaves no administrator at all is refused.

Consumers of `planVersion: 2` must ignore unknown properties, but reject an unknown `planVersion`, `kind`, or `operation`. An unfamiliar protection still blocks the apply, and an unfamiliar warning remains a warning. Additive fields do not change `planVersion`; breaking changes do. The input format's strictly validated `manifest.version` is independent of the plan version.

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

Remote protections, destructive-change checks, output, and exit codes match local mode. Requests time out after 30 seconds by default; set `CAIRNCMS_REMOTE_CONFIG_TIMEOUT` to a duration such as `60s` for slower deployments. After a mutating timeout, run `config snapshot` before retrying because the server may have committed the apply.

A remote snapshot is validated against the local config format before anything is written. Unknown fields in the envelope or a managed document stop the snapshot with exit `3` and leave the directory unchanged; records under unmanaged kinds are ignored. After a mutating apply, the CLI also checks the server's plan and result against the submitted manifest. If they disagree, it exits `3` and asks for a snapshot rather than reporting success because the change may have been applied.

After a timeout, the server's [run record](#run-record) around the failure time, if present, shows what the run did. Its `userAgent` starts with `cairncms-cli/`. The record is best-effort, so its absence is inconclusive and `config snapshot` remains the way to verify the current state. Read its `durationMs` as a hint: an engine time near the timeout means raise `CAIRNCMS_REMOTE_CONFIG_TIMEOUT`, and a short one means the delay was in transport.

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

Exit `1` indicates drift. Exit `2` indicates invalid input, invalid command usage, or a refused destructive apply. Exit `3` indicates an operational or unexpected runtime failure. A `CONFIG_STATE_CHANGED` conflict also exits `2`. The [run record](#run-record) distinguishes it from a refusal through its `result`.

Remote mode (`--url`) maps onto the same scheme. A server below the required version, a `4xx` response, or a missing `--yes` on a mutating apply exits `2`. A transport failure, a `5xx` response, an unrecognized server version, or a malformed response exits `3`. If a mutating remote request fails after the server may already have committed, the message says so and re-running `config snapshot` shows the current state.

### Environment variables

Fields that support interpolation accept a placeholder in the form `{{CAIRNCMS_CONFIG_<NAME>}}`. The placeholder must occupy the entire field value. The CLI reads the value from its environment before it builds a plan. A variable outside the `CAIRNCMS_CONFIG_` namespace or a variable that is not set stops the command.

The HTTP API does not resolve placeholders. Send resolved values in the request body.

Whole-string placeholder syntax cannot be stored as a role name or description because a later read would substitute it. Both surfaces reject a desired value of the form `{{NAME}}` as `CONFIG_INVALID`, including an environment value that resolves to that form. Existing database values in that form stop snapshot and apply with `CONFIG_READ_FAILED`; a remote snapshot containing one is refused before anything is written. Rename the value, then retry.

Remote mode reads three further variables, none of which are interpolated into config records: `CAIRNCMS_TOKEN` or `CAIRNCMS_TOKEN_FILE` supplies the administrator token (see [Applying to a remote instance](#applying-to-a-remote-instance)), and `CAIRNCMS_REMOTE_CONFIG_TIMEOUT` overrides the 30-second per-request timeout.

## The HTTP API

The same workflow over HTTP, restricted to admin tokens.

### Retrieve a snapshot

```
GET /config/snapshot
GET /config/snapshot?export=yaml
GET /config/snapshot?manifest_version=1&resources=roles,permissions
```

Returns the current roles and permissions as a JSON payload, or as a YAML attachment when `?export=yaml` is set. The `data` envelope wraps the payload the same way every other CairnCMS API response does. The endpoint opts out of response caching, so subsequent calls always reflect the current database state.

A snapshot request has no manifest body, so `manifest_version` and `resources` select the manifest written into the response. Omit them for the current version and all supported kinds. Use `resources=` for an explicitly empty scope. The remote CLI sends these values automatically from an existing local manifest, or uses its supported version and kinds for a new directory.

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

Each flag accepts exactly `true` or `false`. Any other value, such as `1`, `True`, an empty value, or a repeated parameter, is rejected with `400` and the `CONFIG_INVALID` code before the server reads any state, so a malformed preview flag can never turn into a mutating apply.

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
  }
}
```

The response also includes the plan computed before the mutation under `meta.plan`.

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

### Run record

Every engine run on either surface attempts to write one structured log record when it finishes, so an operator can see what each plan or apply did without reading activity rows. Dry runs and refusals are recorded too, since they mutate nothing and would otherwise leave no trace. The record is best-effort: a logging failure never changes the run's outcome, so a present record is authoritative while an absent one proves nothing. Alongside pino's standard `level` and `time` fields, the record carries:

```json
{"event":"config.run.finished","runId":"3f6c1b0e-9b2c-4a1d-8f2e-0a7d5c4b3e21","source":"http","caller":{"kind":"user","user":"<uuid>","role":"<uuid>"},"userAgent":"cairncms-cli/1.6.0","dryRun":false,"destructive":true,"manifestVersion":1,"managedKinds":["roles","permissions"],"changes":{"create":1,"update":2,"delete":1},"result":"applied","durationMs":184,"msg":"Config run finished"}
```

- **`result`** — `no_changes`, `planned`, `discarded`, `refused`, `invalid`, `state_changed`, `applied`, `post_apply_failed`, or `failed`. `planned` is a dry run whose plan holds changes. `discarded` is a plan the operator declined at the prompt. `post_apply_failed` means the database changes were applied and only the post-apply cache maintenance failed.
- **`errorCode`** — present for `refused`, `invalid`, `state_changed`, `failed`, and `post_apply_failed`: the typed error code, such as `DESTRUCTIVE_CHANGES_REQUIRED`, or `UNEXPECTED` for an error outside the config error set.
- **`source`** — `cli` for a local `config apply`, `http` for `POST /config/apply`, including runs driven by the remote CLI, whose `userAgent` starts with `cairncms-cli/`.
- **`caller`** — the administrator's user and role ids on an HTTP run, or the system actor with origin `config-cli` on a local run.
- **`changes`** — the plan's create, update, and delete counts, never the changes themselves.
- **`durationMs`** — engine time, from the moment the request or command has been parsed and validated to the record.

The server writes the record at `info` level under both log styles. The local CLI writes it only under `LOG_STYLE=raw`, so interactive output is unchanged and a CI runner that sets raw gets one JSON line per run. Failures before the engine starts, such as a bad flag, an unreadable config directory, an unreachable database, or an unparseable request body, produce no record because the command or the request already reports them.

Every response from a `POST /config/apply` run that reached the engine carries the run id in `X-Config-Run-Id`: on success and on every error the run produces, such as a refusal, a state conflict, or a failure. A request rejected before a run starts, by authentication, an unsupported media type, or an invalid manifest, carries no run id and produces no record, so a run id identifies exactly one record when emission succeeds. The header is exposed to browser clients through the default `CORS_EXPOSED_HEADERS`. The remote CLI prints it as `Run <id>`, on standard error under `--format json`. A local run has no run id because nothing else on the machine could correlate it. The record complements the per-record activity and revisions above rather than replacing them.

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
- **`CONFIG_READ_FAILED`** (500) — required database state is unreadable, such as an orphaned or duplicate permission row.
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
