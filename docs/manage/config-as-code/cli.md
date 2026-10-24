---
title: CLI reference
description: Config-as-code commands, flags, local requirements, and exit codes.
sidebar:
  order: 5
---

Use the config-as-code CLI with a directory of YAML files. Local mode uses the CLI process's database environment variables. Remote mode uses `--url` and does not need local `DB_*` settings.

## Snapshot

```text
cairncms config snapshot <path> [--yes] [--url <url>] [--token-stdin]
```

`path` is required. A new directory captures manifest version 3 and all supported kinds. An existing manifest preserves its version and resource list. To select resources, pre-create the [manifest](/docs/manage/config-as-code/resources/#the-manifest).

The CLI prompts before overwriting a non-empty directory. `--yes` skips that prompt. With `--token-stdin`, a non-empty remote destination also requires `--yes`.

Snapshot writes YAML files. Use the [HTTP snapshot](/docs/manage/config-as-code/http-api/#retrieve-a-snapshot) for a single JSON or YAML document. Save any pending edits before snapshotting over an existing directory.

## Apply

```text
cairncms config apply <path> [--dry-run] [--format human|json]
  [--yes] [--destructive] [--force-schema] [--url <url>] [--token-stdin]
```

The default format is `human`. Local mutating apply prints the plan and asks for confirmation. `--yes` skips confirmation. A mutating remote apply requires `--yes`. Preview it separately before using that option.

| Option | Meaning |
| --- | --- |
| `--dry-run` | Validate and preview without writes |
| `--format json` | Print one versioned plan on stdout. Only with `--dry-run` |
| `--destructive` | Authorize planned deletions, not all potentially lossy updates |
| `--force-schema` | Waive a missing or mismatched schema source release/vendor check |
| `--url` | Use a remote instance instead of the local database |
| `--token-stdin` | Read the remote administrator token from stdin |

Use `cairncms config apply --dry-run` to preview. It shows deletions and protections without requiring `--destructive`. Invalid input, missing references and source incompatibility can still prevent a preview. Neither override bypasses validation or protections.

## Exit codes

| Apply outcome | Exit |
| --- | --- |
| Success, no changes, declined local confirmation, or help | `0` |
| Dry run with planned changes or protections | `1` |
| Invalid usage/input or a refusal with no committed/uncertain changes | `2` |
| Unexpected failure, unreadable state, transport failure, or a failure after a committed step | `3` |

Exit `3` requires checking the target before retrying. See [Failure recovery](/docs/manage/config-as-code/recovery/), especially after a remote timeout.

Snapshot exits `0` on success, declined overwrite or help. It exits `2` on usage errors or an invalid existing tree. Unreadable state, connection failures and unexpected errors exit `3`. A malformed remote capture is refused before it writes files.

For unattended apply, use `--yes` after reviewing the preview. For handling the expected preview exit `1`, see [CI previews](/docs/manage/config-as-code/deployments/#use-previews-in-ci).

## Environment and output

Local commands require an initialized database and working database access. Set supported `CAIRNCMS_CONFIG_*` placeholders in the CLI process's environment. Provision extension secrets on the target separately.

Remote credentials use exactly one of `CAIRNCMS_TOKEN`, `CAIRNCMS_TOKEN_FILE` or `--token-stdin`. The timeout variable is `CAIRNCMS_REMOTE_CONFIG_TIMEOUT`. See [Remote instances](/docs/manage/config-as-code/remote/) for TLS and token-file requirements.

Use JSON dry-run output for automation rather than parsing human messages. The plan goes to stdout and logs go to stderr. See [Apply output](/docs/manage/config-as-code/output/).
