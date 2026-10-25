---
title: Deploying across environments
description: Capture, review and deploy the same config-as-code files through staging and production.
sidebar:
  order: 2
---

Make changes on your development instance, capture a snapshot, review the files in source control, and deploy the same files to staging and production. Use [direct file edits](/docs/manage/config-as-code/resources/#when-to-edit-files) only for specific needs outside that normal workflow.

## Prepare source and target

Use the same CairnCMS release and database vendor. Align extension packages and their settings declarations before applying extension settings. Provision instance-specific secrets separately.

Back up the target database and file storage. A config-as-code snapshot is not a data backup.

Choose the [managed resources](/docs/manage/config-as-code/scope-and-deletions/) before capturing. Keep the complete desired set for each selected kind, including collections and roles that this deployment does not change.

## Capture and review

On the source instance:

```bash
cairncms config snapshot ./config
```

Review the manifest and changed files in source control. Check role access flags, permission filters, deleted collections and fields, folder keys, and environment-specific settings. An existing directory retains its version and selected kinds.

Keep the reviewed files unchanged during promotion. Capture target-side edits into a separate directory if you need to compare them. Snapshotting over the deployment tree would replace the changes you intend to deploy.

## Preview the actual target

Load the target's database configuration for a local deployment process:

```bash
cairncms config apply ./config --dry-run
```

For a remote target, configure one [token source](/docs/manage/config-as-code/remote/), then run:

```bash
cairncms config apply ./config --url https://staging.example.com --dry-run
```

Review the proposed changes and warnings. Resolve unexpected deletions before proceeding. If the target changes after review, preview again.

## Coordinate live work

Schedule disruptive changes with the applications that use the affected data. Requests, realtime connections, flows and background jobs can encounter a partly updated project during an apply. Coordinate affected work across all replicas, including work already running, and avoid competing administrative edits. After failure, [inspect or recover the target](/docs/manage/config-as-code/recovery/) before resuming affected work.

Check applications that use removed or renamed fields. If existing data needs transformation, prepare a [custom migration](/docs/develop/custom-migrations/) as part of the deployment.

## Apply and verify

```bash
cairncms config apply ./config --url https://staging.example.com --yes
```

Add `--destructive` only for intended deletions. Add `--force-schema` only after evaluating a release/vendor mismatch. It waives the check, not the underlying incompatibility.

After success, verify application behavior and run another dry run. Promote the same files to production using production credentials and a fresh preview. After failure or a lost response, follow [Failure recovery](/docs/manage/config-as-code/recovery/) before retrying.

## Use previews in CI

This shell example treats exit `1` as a valid preview:

```bash
status=0
cairncms config apply ./config --dry-run --format json > config-plan.json || status=$?
if [ "$status" -eq 0 ]
then
  printf '%s\n' 'No changes or protections.'
elif [ "$status" -eq 1 ]
then
  printf '%s\n' 'Review config-plan.json before deployment.'
else
  exit "$status"
fi
```

Keep apply behind your deployment approval gate. Review deletions, warnings and protections in `config-plan.json` first. See [Apply output](/docs/manage/config-as-code/output/) for the JSON format.
