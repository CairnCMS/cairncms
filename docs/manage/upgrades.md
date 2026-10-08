---
title: Upgrades
description: How CairnCMS versions are released, the standard upgrade procedure, and how to roll back when something goes wrong.
sidebar:
  order: 5
---

This page covers versioning, upgrades, rollback, and the considerations for multi-instance deployments, custom migrations, and extensions.

## Versioning policy

CairnCMS uses the Semantic Versioning number format (`MAJOR.MINOR.PATCH`) but does not promise strict SemVer compatibility. Minor releases can remove features after a deprecation notice, and necessary security fixes can change supported behavior in patch or minor releases.

- **Patch** (`1.2.3` to `1.2.4`): compatible bug fixes and security updates. Breaking changes are limited to necessary security fixes described below.
- **Minor** (`1.2.3` to `1.3.0`): new features, fixes, and removals whose deprecation period has elapsed. A minor release may also include dependency-required platform updates or necessary security changes.
- **Major** (`1.x` to `2.x`): broader API, SDK, or platform changes, with dedicated migration guidance.

These rules cover documented REST and GraphQL APIs, published SDK and extension APIs, documented configuration and CLI commands, and supported data formats and deployment requirements. CairnCMS's internal implementation details are outside this compatibility promise.

Releases have versioned container image tags such as `cairncms/cairncms:1.2.3`. To check the installed version, run `cairncms --version`. An admin-authenticated `GET /server/info` request also returns it at `data.cairncms.version`.

### Deprecation notices

A deprecated feature remains supported while you migrate away from it. We announce deprecations in a stable minor release. A feature can be removed in a later minor release, but no sooner than **30 calendar days after the announcing release is published**.

Look for a **Deprecations** section in the [changelog](https://github.com/CairnCMS/cairncms/blob/main/CHANGELOG.md) and the corresponding [GitHub release notes](https://github.com/CairnCMS/cairncms/releases). The affected documentation also carries a notice, with SDK `@deprecated` annotations where applicable. Each notice identifies the feature, why it is being retired, the replacement or lack of one, and the earliest removal version and date.

When removal ships, its **Potential Breaking Changes** entry explains who is affected, how to migrate, and which release announced the deprecation.

### Security fixes

A patch or minor release may restrict or remove a feature without the normal notice period when a vulnerability cannot reasonably be fixed without changing supported behavior. We limit the changes to what the security fix requires.

The release's **Potential Breaking Changes** section names affected callers and provides migration guidance, or states when no safe replacement exists.

### Platform requirements

A minor release may raise a system-library, runtime, or browser requirement when a dependency update requires it, without the normal deprecation period. These changes appear under **Potential Breaking Changes**, with instructions for meeting the new requirement.

This applies only to the new requirement itself. Removing an API, configuration option, or support for a database vendor or version still requires notice unless a security exception applies. Choosing to retire a supported runtime independently of a dependency requirement also follows the notice period.

## Before you upgrade

1. **Take a backup.** A full database dump and, if files have changed since the last backup, a copy of the storage volume. See [Backups](/docs/manage/backups/).
2. **Read the changelog** for every version between yours and the target, especially **Deprecations** and **Potential Breaking Changes**. Follow its migration instructions for configuration, clients, and extensions.
3. **Test in a non-production environment first** if you can. A staging instance restored from production data, run through the upgrade, is the cheapest way to surface upgrade-time problems before they reach users.

For major-version upgrades, also:

- Audit your extensions against the [extension compatibility guidance](#extension-compatibility). A declared `host` range does not guarantee compatibility or prevent an incompatible extension from loading.
- Follow the release's dedicated migration notes.

## The standard upgrade

Follow any release-specific instructions alongside this standard upgrade procedure:

### Docker image

```bash
# Pull the new tag
docker pull cairncms/cairncms:1.3.0

# Update your compose file or deployment manifest to reference 1.3.0
# Stop the running container, start the new one
docker compose up -d cairncms
```

The image's default `CMD` runs `cairncms bootstrap` on startup. Bootstrap ensures system tables exist and applies pending migrations. After migrations complete, `cairncms start` boots the API.

For a multi-host or orchestrated deployment, the equivalent step is whatever your platform does to rotate the running version: a `kubectl rollout restart`, an ECS service update, a Fly deploy, and so on.

### Host install

If you run CairnCMS directly on a host:

```bash
npm install -g cairncms@1.3.0
cairncms bootstrap
# Restart your process supervisor (systemd, PM2, etc.)
```

`cairncms bootstrap` is idempotent meaning it's safe to run on every upgrade. It applies pending migrations and flushes the schema cache.

### What bootstrap does on upgrade

On a deploy that bumps the CairnCMS version:

1. Bootstrap reads the database's `directus_migrations` table to determine which migrations have already run.
2. It applies any newer migrations the upgraded version ships, in version order, and records each one as it completes.
3. After all pending migrations are applied, it flushes schema and permission caches so the next request sees the new structure.
4. `cairncms start` boots the API. On startup, `start` itself only validates that all known migrations have been applied; it does not run migrations.

For most deployments, this means "pull the new image, restart" is the entire upgrade. The platform handles the rest.

## Multi-instance upgrades

Behind a load balancer with multiple CairnCMS instances, the migration step needs to run exactly once, not once per instance. The migrations runner does not coordinate across instances. It reads `directus_migrations`, applies whatever has not been applied yet, and inserts the completion rows. Two instances running `bootstrap` at the same time will both read the same pending list and both try to apply the same migrations, which races at best and corrupts state at worst.

The remedy is to keep the migration step out of the steady-state pod startup:

1. Run `cairncms bootstrap` once against the database, typically as a one-shot job or init container, and wait for it to complete.
2. Once migrations are done, roll the fleet onto the new image. The new instances start, observe that all migrations are already applied, and serve traffic.

In Kubernetes, the cleanest shape is a Job (or init container) that runs `cairncms bootstrap` before the rolling update of the main Deployment. The Job blocks the rollout if migrations fail, which surfaces the problem before any user traffic hits the new version.

For a single-host Docker Compose deployment that scales to one CairnCMS replica, the default image `CMD` (which runs `bootstrap` then `start`) is fine. There is no second runner to race against. The split job pattern only matters once you have more than one instance.

## Rolling back

Rollback is the reverse of the upgrade with one extra step.

### Patch and minor version rollback

If the database has not been changed (no new migrations applied), rollback is just an image rollback:

```bash
docker pull cairncms/cairncms:1.2.3
docker compose up -d cairncms
```

If migrations did run, roll those back first:

```bash
# One step at a time — each invocation reverses one migration
cairncms database migrate:down
cairncms database migrate:down
# ...until you are at the target version's expected migration state
```

`migrate:down` is destructive. The migration's `down()` is responsible for reversing the schema change, but data added after the migration ran can still be lost (a column that was added by the migration and populated since cannot be restored after the column is dropped). When in doubt, restore from the backup taken before the upgrade rather than relying on `down` migrations.

### Major version rollback

A major version is, by policy, allowed to ship migrations that do not have a clean down path. Treat major-version rollback as a restore-from-backup operation, not a step-down operation. The pre-upgrade backup is the source of truth; reapply it to a `1.x` instance on the previous image tag, redirect traffic, and investigate the upgrade failure offline.

This is also why the pre-upgrade backup is non-negotiable. Without it, a major-version rollback may not be possible.

## Custom migrations and upgrades

Custom migrations placed in `EXTENSIONS_PATH/migrations` are interleaved with platform migrations by version timestamp at runtime. This has two consequences for upgrades:

- **Newer custom migrations run during the upgrade.** If you have added a custom migration since the last deploy, it runs as part of `bootstrap` alongside any new platform migrations.
- **A custom migration with a timestamp earlier than the last applied platform migration will not run.** The migrations runner only applies versions newer than the latest completed one. Pick custom-migration timestamps that put them after any platform migrations they depend on.

See [Custom migrations](/docs/develop/custom-migrations/) for the file format and CLI commands.

## Extension compatibility

Each extension's `package.json` declares a host range:

```json
{
  "cairncms:extension": {
    "host": "^1.0.0"
  }
}
```

This field is informational. CairnCMS surfaces it in extension metadata so operators and tooling know which platform versions an extension was built against, but the loader does not enforce the range. An extension whose declared `host` excludes the running platform version still loads.

Check release notes for extension API deprecations, removals, and security changes on every upgrade. A matching `host` range does not exempt an extension from those changes. For major upgrades, or whenever release notes require extension changes:

1. Apply required code or manifest changes and update each extension's `host` range to match the versions you have tested.
2. Rebuild against the new SDK version with `npm run build` (which calls `cairncms-extension build`).
3. Run the extension's tests, if any, against the upgraded SDK.
4. Reinstall or redeploy the extension alongside the platform upgrade.

If you skip the rebuild on a major upgrade, the extension may still load, but it can fail at runtime when it calls SDK helpers whose contracts have changed. Treating the rebuild as part of the major-upgrade procedure is the safe default.

Bundles use the same `host` field; rebuilding a bundle rebuilds all of its entries.

App extensions carry an extra consideration. They share the admin app's Vue runtime rather than bundling their own, so a host-Vue or SDK change can require rebuilding them even within a compatible `host` range. If an app extension fails to mount after an upgrade, rebuild it against the current SDK before investigating further. See [Creating extensions](/docs/develop/extensions/creating-extensions/).

Confined extensions depend on the capability and settings vocabulary and the brokered host API. Changes follow the same compatibility and deprecation rules. A confined extension may need its manifest `capabilities`, its `settings` declaration, or its `host.*` usage updated when those evolve. The [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) reference documents the current capability set.

## Where to go next

- [Backups](/docs/manage/backups/) — the prerequisite for any upgrade you would actually be willing to roll back from.
- [Deployment](/docs/manage/deployment/) — covers the bootstrap-and-start pattern in more detail, including the Kubernetes init-container shape.
- [Custom migrations](/docs/develop/custom-migrations/) — the file format, version naming, and CLI commands for migrations you write yourself.
