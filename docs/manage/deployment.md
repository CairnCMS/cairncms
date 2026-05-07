---
title: Deployment
description: Run CairnCMS in production using the official Docker image, Compose, and other container platforms.
sidebar:
  order: 2
---

CairnCMS is a Node.js application packaged as a Docker image. The recommended deployment shape is to run the official image alongside your database and (optionally) Redis, with the platform you already use for everything else: Docker Compose on a single host, Kubernetes, ECS, Fly, Railway, Render, or any other container runtime.

This page covers how the image is built, what the `cairncms init` scaffold gives you, where the scaffold ends and production decisions begin, and the patterns for running CairnCMS at scale.

## The official image

The CairnCMS image is published on two registries:

- `cairncms/cairncms` on Docker Hub
- `ghcr.io/cairncms/cairncms` on GitHub Container Registry

Tags follow the project's release versions (for example, `cairncms/cairncms:1.0.0`). A `latest` tag tracks the latest stable release. Multi-arch images are published for `linux/amd64` and `linux/arm64`.

The image is based on `node:22-alpine`, runs as the unprivileged `node` user, and exposes port 8055. It contains:

- the compiled API
- the built admin app, served by the API
- a CLI bin (`cairncms`) for migrations, bootstrap, user management, and config workflows

By default the image expects state at three paths inside the container:

- `/cairncms/database` — SQLite file location, when using SQLite
- `/cairncms/uploads` — the local-disk storage backend
- `/cairncms/extensions` — custom extensions, migrations, and email templates

The default `CMD` runs `cairncms bootstrap` (which ensures system tables exist and applies pending migrations), then `cairncms start` to serve requests.

## The init scaffold

The fastest way to a working local stack is the scaffold:

```bash
npx cairncms init my-cms
```

This creates `my-cms/cairncms/` with three files relevant to deployment:

- `docker-compose.yml` — three services: PostgreSQL with PostGIS, Redis, and CairnCMS. Mounts volumes for uploads, extensions, snapshots, and config-as-code.
- `.env` — random secrets, a default admin account, and the database connection details. Gitignored.
- `README.md` — quick reference for the stack.

The scaffold is for local development and content modeling. It is not a production-ready template. See the next section for what to change before deploying.

## From scaffold to production

The scaffold makes choices that work locally but should be revisited for any environment beyond a developer laptop:

### Database image architecture

The scaffold's database service uses `postgis/postgis:16-3.4-alpine`, which is `linux/amd64` only. On ARM hosts (AWS Graviton, ARM-based Kubernetes nodes, Apple Silicon production), pull a multi-arch image instead. Plain `postgres:16-alpine` is multi-arch and works for any project that does not use geometry fields.

### Secret management

The scaffold writes random secrets to a local `.env` file. For production:

- Source `KEY`, `SECRET`, `DB_PASSWORD`, and any provider credentials from a secret store (your platform's secret manager, HashiCorp Vault, AWS Secrets Manager, or similar).
- Do not commit `.env` to source control. The scaffold gitignores it; preserve that.
- Rotate `SECRET` carefully. Rotating it invalidates all existing sessions, which is sometimes the goal but should be intentional.

### Public URL

The scaffold defaults `PUBLIC_URL` to `http://localhost:<port>`. Set it to the externally-reachable URL — `https://cms.example.com`, including scheme — before any deployment. Asset URLs, redirect targets, and email links are all built from this value.

### TLS

The image does not terminate TLS. Run a reverse proxy (Caddy, Traefik, nginx) or a managed load balancer in front of CairnCMS to handle HTTPS. Set `IP_TRUST_PROXY=true` (the default) so CairnCMS reads `X-Forwarded-For` for the real client IP.

### Cookie security

For production over HTTPS:

```bash
REFRESH_TOKEN_COOKIE_SECURE=true
REFRESH_TOKEN_COOKIE_SAME_SITE=strict
```

The scaffold defaults to `false`/`lax` for local dev. Override these explicitly in your production environment.

### Persistent volumes

The scaffold's `cairncms` service mounts four directories:

- `./uploads` — file bytes for the local storage backend
- `./extensions` — custom extensions, migrations, and email templates
- `./snapshots` — schema and config snapshot output (used by `cairncms schema` and `cairncms config` CLI commands)
- `./config` — config-as-code working directory

In production, these need to be backed by durable storage:

- For uploads, prefer a remote storage backend (S3, GCS, Azure Blob, Cloudinary) over a mounted volume. Files outlive container instances; the storage backend is the durability surface, not the volume.
- For extensions, the directory should be part of your container image or pulled in at build time, not edited in production.
- For snapshots and config, these are output paths used by CLI workflows. Mount them only on the host where you run those commands.

## Running without Docker

If you prefer to run CairnCMS directly on a host:

1. Install Node.js 20 (or newer) on the host.
2. Install the CairnCMS package: `npm install -g cairncms` (or use the source tree if you're building from this repo). The `cairncms` package is the one that registers the `cairncms` CLI binary.
3. Provide the configuration through a `.env` file or environment variables (see [Configuration](/docs/manage/configuration/)).
4. Run `cairncms bootstrap` once to install system tables and apply migrations.
5. Run `cairncms start` (typically under a process supervisor like systemd or PM2).

The Docker image is a packaging convenience, not a hard requirement.

## The bootstrap and start pattern

CairnCMS separates initialization from serving:

- **`cairncms bootstrap`** ensures the database has the system tables, applies pending migrations, and (on first run) creates a default admin user. Idempotent — safe to run on every deploy.
- **`cairncms start`** boots the API process. Does not run migrations on its own; it only validates that all known migrations have been applied and warns if any are missing.

The official Docker image runs `bootstrap` then `start` from its `CMD`, so a freshly-deployed container ends up with up-to-date schema and a running server. For platforms that expect a long-running process, this is fine. For platforms that want a separate migration step, run `cairncms bootstrap` as a one-shot job before scaling up the long-running service.

For Kubernetes specifically, an init container running `cairncms bootstrap` followed by the main container running `cairncms start` is the cleanest split. The init container can also act as a sanity check that fails the deploy if migrations cannot be applied.

## Reverse proxy notes

A typical proxy configuration:

- Forward `/admin` and the API endpoints (`/items`, `/files`, `/auth`, etc.) to CairnCMS.
- Set `Host`, `X-Forwarded-Proto`, and `X-Forwarded-For` headers.
- Cache static asset routes (`/admin/assets/*`) aggressively at the proxy.

Sample Caddy snippet:

```
cms.example.com {
    reverse_proxy cairncms:8055
}
```

Sample nginx snippet:

```
server {
    listen 443 ssl http2;
    server_name cms.example.com;
    location / {
        proxy_pass http://cairncms:8055;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Resource sizing

CairnCMS itself is light. The platform's resource needs are dominated by:

- the database (sized to your dataset and concurrency)
- file storage (sized to your asset volume)
- transformation throughput, when serving on-the-fly image transforms

A small project (single instance, modest traffic, S3-backed storage, Postgres) runs comfortably on 1 vCPU and 1 GB RAM for the CairnCMS container. Image transformations spike CPU and memory on demand; a heavy public-facing site benefits from caching transformed assets at the CDN layer. The `ASSETS_TRANSFORM_*` configuration variables control concurrency limits — see [Configuration](/docs/manage/configuration/).

## Multi-instance deployments

To run CairnCMS behind a load balancer with more than one instance:

- **Database**: a single shared instance; CairnCMS does not expect to be the only writer, but it is the source of truth for its system tables.
- **Storage**: use a remote backend (S3-compatible, GCS, Azure, or Cloudinary). Local-disk storage does not survive container restarts and cannot be shared across instances.
- **Cache and rate limiter**: switch to Redis-backed stores so limits and cached responses are shared across instances. See [Configuration](/docs/manage/configuration/) for `CACHE_REDIS`, `RATE_LIMITER_REDIS`, and `MESSENGER_REDIS`.
- **Messenger**: required for cross-instance event coordination. Set `MESSENGER_STORE=redis` and configure `MESSENGER_REDIS` so all instances see the same events.

Without these, multi-instance deployments work for read-heavy workloads but exhibit drift on writes, i.e. items created on instance A may not appear in cached responses from instance B until the cache TTL elapses.

## Where to go next

- [Configuration](/docs/manage/configuration/) is the reference for every environment variable mentioned here.
- [Security hardening](/docs/manage/security-hardening/) covers HTTPS, secrets, rate-limiting, and other production-safety topics.
- [Backups](/docs/manage/backups/) and [Upgrades](/docs/manage/upgrades/) cover ongoing operational tasks.
