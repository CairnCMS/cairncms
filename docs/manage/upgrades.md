---
title: Upgrades
description: How CairnCMS versions are released, the standard upgrade procedure, and how to roll back when something goes wrong.
---

CairnCMS follows semantic versioning. Most upgrades are routine: pull the new image, restart the container, and the database catches up automatically on startup. The work that does need attention is the small amount of structural and operational care around an upgrade, including taking a backup, reading the changelog, choosing the right window, and rebuilding extensions when a major version moves the host range.

This page covers the upgrade procedure, the rollback path, and the considerations specific to multi-instance and major-version upgrades.

## Versioning policy

CairnCMS uses semver. For a given version `MAJOR.MINOR.PATCH`:

- **Patch** (`1.2.3` → `1.2.4`) — bug fixes and security patches. No schema changes that require a code change on your side, no breaking API or extension contract changes.
- **Minor** (`1.2.3` → `1.3.0`) — new features, additive changes. The HTTP API, SDK, and extension contracts stay backwards-compatible. Database schema changes happen here, but always through migrations that run automatically.
- **Major** (`1.x` → `2.x`) — breaking changes. Possible API contract changes, extension SDK changes, and migrations that require operator attention. Major upgrades are documented in dedicated migration notes alongside the release.

The version is stamped into every container image tag (`cairncms/cairncms:1.2.3`) and reported by `cairncms --version` on the CLI. The running platform reports its version through the `/server/info` API endpoint.

## Before you upgrade

Three things every time, no exceptions:

1. **Take a backup.** A full database dump and, if files have changed since the last backup, a copy of the storage volume. See [Backups](/docs/manage/backups/).
2. **Read the changelog** for every version between yours and the target. Even within a single minor range, you might have skipped a release that introduced a configuration default change or a deprecated environment variable.
3. **Test in a non-production environment first** if you can. A staging instance restored from production data, run through the upgrade, is the cheapest way to surface upgrade-time problems before they reach users.

For major-version upgrades, also:

- Audit your extensions. Their `cairncms:extension.host` semver range in `package.json` declares which CairnCMS versions they are compatible with. An extension built for `^1.0.0` will not load against `2.x` until it is rebuilt with a compatible range.
- Review breaking-change notes for any deprecated environment variables, removed flags, or schema changes that need manual intervention.

## The standard upgrade

The procedure is the same for any patch or minor version, and most major versions:

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

In practice, that means extension compatibility is your responsibility to manage during upgrades. For minor and patch upgrades within an extension's declared range, the extension keeps working without intervention because the SDK contract is stable. For major upgrades, where the SDK contract may change:

1. Update each extension's `host` range to include the new major.
2. Rebuild against the new SDK version with `npm run build` (which calls `cairncms-extension build`).
3. Run the extension's tests, if any, against the upgraded SDK.
4. Reinstall or redeploy the extension alongside the platform upgrade.

If you skip the rebuild on a major upgrade, the extension may still load, but it can fail at runtime when it calls SDK helpers whose contracts have changed. Treating the rebuild as part of the major-upgrade procedure is the safe default.

Bundles use the same `host` field; rebuilding a bundle rebuilds all of its entries.

## Where to go next

- [Backups](/docs/manage/backups/) — the prerequisite for any upgrade you would actually be willing to roll back from.
- [Deployment](/docs/manage/deployment/) — covers the bootstrap-and-start pattern in more detail, including the Kubernetes init-container shape.
- [Custom migrations](/docs/develop/custom-migrations/) — the file format, version naming, and CLI commands for migrations you write yourself.
