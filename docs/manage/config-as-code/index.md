---
title: Config-as-code
description: Capture your data model, access rules and settings in reviewable files and apply them across environments.
sidebar:
  label: Overview
  order: 0
---

Config-as-code moves your data model, access rules and settings between CairnCMS instances. Capture the source as YAML files, review changes in source control, preview them against the target, and apply the reviewed tree.

Use `cairncms config snapshot` and `cairncms config apply` to manage these resources together in CairnCMS 1.7.0 and later.

<span id="what-a-config-snapshot-captures"></span>

## What travels in the tree

| Resource | Captured state |
| --- | --- |
| [Schema](/docs/manage/config-as-code/resources/schema/) | Collections, fields, relations and their metadata |
| [Roles and permissions](/docs/manage/config-as-code/resources/roles-and-permissions/) | Role keys, access flags and operator-defined permission rules |
| [Folders](/docs/manage/config-as-code/resources/folders/) | File-library folder keys, names and hierarchy |
| [Project settings](/docs/manage/config-as-code/resources/project-settings/) | Supported branding, language, authentication, asset and map settings |
| [Extension settings](/docs/manage/config-as-code/resources/extension-settings/) | Declared stored values for selected extension subjects, without copying secret values |
| [Translations](/docs/manage/config-as-code/resources/translations/) | Custom translation strings grouped by language |

<span id="managed-scope"></span>

The manifest selects which resource kinds the tree manages. An omitted kind is left alone. Within a managed kind, omission can mean deletion. Read [Managed scope and deletions](/docs/manage/config-as-code/scope-and-deletions/) before reducing a tree or applying it to an existing project.

Snapshots do not transfer collection items, user accounts, uploaded file data, file records, or extension packages. Use [Backups](/docs/manage/backups/) or [Migration between instances](/docs/manage/migration-between-instances/) when moving a complete deployment.

## Start with a preview

Run these commands with the local instance's database configuration loaded:

```bash
cairncms config snapshot ./config
cairncms config apply ./config --dry-run
```

The first command captures the instance. The second compares the tree with that instance without changing it. An unchanged capture reports `No changes to apply.`

Back up the target before applying changes.

<span id="source-control-workflow"></span>

Follow [Your first apply](/docs/manage/config-as-code/first-apply/) for a disposable walkthrough, or [Deploying across environments](/docs/manage/config-as-code/deployments/) for the promotion workflow.

<span id="two-surfaces-one-engine"></span>

## Choose a connection

| Surface | Input | Target |
| --- | --- | --- |
| [Local CLI](/docs/manage/config-as-code/cli/) | Directory of YAML files | Database configured for the CLI process |
| [Remote CLI](/docs/manage/config-as-code/remote/) | The same directory | Instance selected by `--url`, using an administrator token |
| [HTTP API](/docs/manage/config-as-code/http-api/) | One complete JSON or YAML document | Server receiving the request |

<span id="where-to-go-next"></span>

## Find the reference you need

- <span id="field-semantics"></span><span id="supported-fields"></span><span id="extension-settings"></span><span id="translations"></span>[Files and resources](/docs/manage/config-as-code/resources/): manifest, layout and supported fields.
- <span id="the-cli"></span><span id="snapshot"></span><span id="apply"></span><span id="exit-codes"></span><span id="environment-variables"></span>[CLI reference](/docs/manage/config-as-code/cli/): commands, options and exit codes.
- <span id="the-http-api"></span><span id="retrieve-a-snapshot"></span><span id="apply-1"></span><span id="no-diff-endpoint"></span>[HTTP API](/docs/manage/config-as-code/http-api/): requests and response formats.
- <span id="applying-to-a-remote-instance"></span>[Remote instances](/docs/manage/config-as-code/remote/): credentials, TLS, version requirements and timeouts.
- <span id="plan-output"></span><span id="machine-readable-output"></span><span id="audit-records-and-events"></span><span id="run-record"></span>[Apply output](/docs/manage/config-as-code/output/): human plans, JSON output and run records.
- <span id="validation"></span><span id="error-responses"></span><span id="repairing-an-unreadable-extension-setting"></span>[Failure recovery](/docs/manage/config-as-code/recovery/): inspect and recover from a failed apply.
- <span id="pairing-with-schema-as-code"></span>[Adopting the unified workflow](/docs/manage/config-as-code/migration/): existing directories and standalone files.
- [Standalone schema commands](/docs/manage/schema-as-code/): the retained compatibility workflow.
