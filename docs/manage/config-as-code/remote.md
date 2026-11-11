---
title: Remote instances
description: Use config-as-code on a remote instance with an administrator token.
sidebar:
  order: 4
---

Pass `--url` to snapshot or apply against a remote CairnCMS instance. Remote mode uses the same directory format as local mode and does not open a local database.

## Provide one token source

Supply an administrator's static token through exactly one source:

- `CAIRNCMS_TOKEN`, usually injected by your CI secret store.
- `CAIRNCMS_TOKEN_FILE`, pointing to a regular secret file. On Unix, group and others must have no access, for example mode `0600`.
- `--token-stdin`, fed by a secret manager or another process.

Use only one source. Do not put tokens into URLs, repository files or command arguments.

Once your secret store has populated `CAIRNCMS_TOKEN`, for example:

```bash
cairncms config snapshot ./config --url https://cms.example.com
cairncms config apply ./config --url https://cms.example.com --dry-run
```

Capture and apply use the same token rules. When stdin supplies a token, overwriting a non-empty snapshot directory requires `--yes` instead of a prompt.

## Target and TLS requirements

Use an absolute `http` or `https` URL without credentials, query or fragment. Prefer HTTPS. The CLI warns before sending an administrator token over unencrypted HTTP.

The CLI does not follow redirects or use environment proxy settings. Point at the actual API base URL, not an address that redirects to it. For a private CA, supply `NODE_EXTRA_CA_CERTS` before starting the CLI. Do not disable TLS verification to work around a deployment error.

Local and private-network targets are supported. If the connection is blocked, check the CLI process's `IMPORT_IP_DENY_LIST` for entries covering the target address.

## Server versions

Remote config needs a server running CairnCMS 1.6.0 or later. The server must also support the tree's [manifest version](/docs/manage/config-as-code/resources/#the-manifest). Trees that manage schema need 1.7.0 or later.

A new empty directory requests the latest manifest version. For capture from an older server, pre-create a manifest with a version that server supports and with supported resources. For example, use version 3 for a 1.7 server, or version 1 or 2 for a 1.6 server.

Capture with a CLI at least as new as the source server. An older CLI refuses a snapshot that contains a field it doesn't know. An older target refuses a tree that sets a field it doesn't support, so upgrade the target before applying a tree captured on a newer release.

`--force-schema` does not bypass the minimum server version. Its separate [source compatibility check](/docs/manage/config-as-code/resources/schema/#source-release-and-vendor) compares the captured schema with the target.

## Preview, then apply

```bash
cairncms config apply ./config --url https://cms.example.com --dry-run
cairncms config apply ./config --url https://cms.example.com --yes
```

A remote apply requires `--yes`. Add `--destructive` only after reviewing intended deletions. The command sends the whole tree in one apply request.

## Timeouts and unverifiable responses

The default request deadline is 30 seconds. For a legitimate longer deployment:

```bash
CAIRNCMS_REMOTE_CONFIG_TIMEOUT=60s cairncms config apply ./config --url https://cms.example.com --yes
```

A timed-out apply may still be running on the server. If the response is lost or cannot be verified, the CLI exits `3` and tells you to re-snapshot before retrying. Follow [Failure recovery](/docs/manage/config-as-code/recovery/), keeping the reviewed tree intact.

When the CLI prints `Run <id>`, use it to find the matching server log. See [Apply output](/docs/manage/config-as-code/output/#run-record) for run records and [CLI reference](/docs/manage/config-as-code/cli/#exit-codes) for exit codes.
