---
title: Configuration
description: How CairnCMS reads its configuration, which environment variables it uses, and how to manage admin tasks like password resets.
sidebar:
  order: 1
---

CairnCMS is configured primarily through environment variables. The same variables work whether you set them in a `.env` file, in your shell, in a Docker Compose file, or in a deployment platform's environment-config UI.

## Where configuration lives

By default, CairnCMS reads `.env` from the current working directory. The path can be overridden with `CONFIG_PATH`, which accepts more than just `.env` text files:

- **`.env`** (default) — standard env-format key/value pairs
- **`.json`** — a JSON object whose keys become environment variables
- **`.yaml` / `.yml`** — a YAML object with the same shape
- **`.js`** — a JavaScript module that exports either an object or a function `(processEnv) => object` that builds the config dynamically

Anything set in the actual process environment takes precedence over the file, which is the standard 12-factor pattern. For most deployments the plain `.env` file is the simplest choice; the alternate formats are useful for environments that want to compute config or share it with non-CairnCMS tooling.

The `cairncms init` scaffold writes a starter `.env` to `cairncms/.env` with random secrets and a default admin password. Operators usually edit that file before first deploy and source-control everything except secret values.

For Docker deployments, the same variables come from the `environment:` block of the Compose service or from a referenced env file. Treat the values as secrets. Never commit a `.env` file with real credentials to source control.

## Type casting

Most environment variables are auto-coerced based on a known internal type map: `PORT` is read as a number, `DB_NAME` as a string, `RATE_LIMITER_ENABLED` as a boolean, and so on. For variables that aren't in the type map, CairnCMS infers the type from the value (`"true"`/`"false"` to boolean, numeric strings to numbers, JSON-shaped strings to objects).

To force a specific type, prefix the value with the type name and a colon:

```bash
DB_PASSWORD="string:1234567890"
CACHE_TTL="string:5m"
DB_EXCLUDE_TABLES="array:spatial_ref_sys,sysdiagrams"
ASSETS_TRANSFORM_PRESETS='json:{"thumb":{"width":200}}'
```

Recognized prefixes: `string`, `number`, `regex`, `array`, `json`. There is no `boolean:` prefix; for boolean-typed variables, the auto-inference of `"true"` / `"false"` is sufficient. Use a prefix when the inferred type would be wrong, for example, when a numeric-looking password should stay a string.

## Server

Variables that control how CairnCMS listens for requests:

- **`HOST`** — interface to bind. Default `0.0.0.0`.
- **`PORT`** — port to listen on. Default `8055`.
- **`PUBLIC_URL`** — the externally-reachable URL of the instance. Used to construct asset URLs, redirect targets, and email links. Set this whenever the instance is reachable through a hostname or path that isn't `http://localhost:8055`.
- **`MAX_PAYLOAD_SIZE`** — the maximum request body size. Default `1mb`. Increase when receiving large uploads or imports.
- **`MAX_RELATIONAL_DEPTH`** — how deeply nested a single query can fetch related data. Default `10`.
- **`MAX_BATCH_MUTATION`** — limit on items in a batch create/update/delete. Default unlimited.
- **`ROBOTS_TXT`** — the body served at `/robots.txt`. Default disallows all crawlers.
- **`ROOT_REDIRECT`** — where requests to `/` redirect. Default `./admin`.
- **`SERVER_SHUTDOWN_TIMEOUT`** — milliseconds to wait for in-flight requests during shutdown. Default `1000`.
- **`IP_TRUST_PROXY`** — whether Express should trust `X-Forwarded-For` headers. Default `true` (assumes a reverse proxy in front).
- **`IP_CUSTOM_HEADER`** — alternative header to read the client IP from, when not using `X-Forwarded-For`.

## Database

CairnCMS supports SQLite, PostgreSQL, MySQL, MariaDB. The connection is configured through:

- **`DB_CLIENT`** — `sqlite3` for SQLite, `pg` for PostgreSQL, `mysql` for both MySQL and MariaDB. MariaDB does not have a separate client value; it shares MySQL's underlying driver.
- **`DB_HOST`** / **`DB_PORT`** / **`DB_DATABASE`** / **`DB_USER`** / **`DB_PASSWORD`** — connection details for server-based databases.
- **`DB_FILENAME`** — path to the SQLite database file. SQLite-only.
- **`DB_SSL__*`** / **`DB_POOL__*`** — SSL options and connection pool tuning. Use the double-underscore syntax to express nested config (`DB_SSL__REJECT_UNAUTHORIZED=false`, `DB_POOL__MIN=2`).
- **`DB_EXCLUDE_TABLES`** — comma-separated table names that CairnCMS should ignore even if it can read them. Default skips Postgres geometry housekeeping (`spatial_ref_sys`) and SQL Server diagrams (`sysdiagrams`).

### MySQL and MariaDB charset

When using MySQL or MariaDB, set the database, table, and column character set to `utf8mb4`. The default `utf8` in older MySQL versions cannot store characters that take four bytes in UTF-8 — including most CJK characters and almost all emoji.

```bash
DB_CHARSET="utf8mb4"
```

If you are connecting to an existing MySQL database, also confirm at the server level that `character_set_server=utf8mb4` and that any pre-existing tables have been altered if they were originally created with `utf8`. Otherwise inserts of unsupported characters will fail or silently truncate.

## Storage

CairnCMS supports multiple storage backends. The active backend list and per-backend config:

- **`STORAGE_LOCATIONS`** — comma-separated list of storage locations. Each location's settings are scoped under `STORAGE_<LOCATION>_*` variables. Default `local`.
- **`STORAGE_<LOCATION>_DRIVER`** — `local`, `s3`, `gcs`, `azure`, or `cloudinary`.

Per-driver settings vary. For local disk:

```bash
STORAGE_LOCATIONS="local"
STORAGE_LOCAL_DRIVER="local"
STORAGE_LOCAL_ROOT="./uploads"
```

For S3 (or any S3-compatible service such as MinIO, DigitalOcean Spaces, or Cloudflare R2):

```bash
STORAGE_LOCATIONS="s3"
STORAGE_S3_DRIVER="s3"
STORAGE_S3_KEY="..."
STORAGE_S3_SECRET="..."
STORAGE_S3_BUCKET="..."
STORAGE_S3_REGION="us-east-1"
STORAGE_S3_ENDPOINT="https://s3.amazonaws.com"
```

Multiple locations can be configured simultaneously and individual files can live on different backends. The `Storage` field on each file record records which location holds the bytes.

## Authentication and sessions

- **`KEY`** — required. A unique identifier for this CairnCMS instance, surfaced as the service ID in server info and health-check responses. Not used to sign tokens or name cookies — that is `SECRET`'s job.
- **`SECRET`** — required. Random secret used to sign access and refresh tokens. Treat as a credential. Changing it invalidates every existing token.
- **`ACCESS_TOKEN_TTL`** — short-lived access token lifetime. Default `15m`.
- **`REFRESH_TOKEN_TTL`** — refresh token lifetime. Default `7d`.
- **`REFRESH_TOKEN_COOKIE_NAME`** — name of the refresh-token cookie. Default `cairncms_refresh_token`.
- **`REFRESH_TOKEN_COOKIE_SECURE`** — set to `true` for production over HTTPS. Default `false`.
- **`REFRESH_TOKEN_COOKIE_SAME_SITE`** — `strict`, `lax`, or `none`. Default `lax`.
- **`REFRESH_TOKEN_COOKIE_DOMAIN`** — domain to scope the cookie to, for cross-domain SSO setups.
- **`LOGIN_STALL_TIME`** — milliseconds failed logins wait before responding, to mitigate timing attacks. Default `500`.
- **`PASSWORD_RESET_URL_ALLOW_LIST`** / **`USER_INVITE_URL_ALLOW_LIST`** — comma-separated URLs allowed for password reset and user invite links.
- **`AUTH_PROVIDERS`** — comma-separated list of SSO providers to enable. See the [Auth](/docs/guides/auth/) guide for provider-specific configuration.
- **`AUTH_DISABLE_DEFAULT`** — when `true`, the built-in email/password login is disabled and only configured SSO providers can authenticate.

## CORS

Disabled by default. Enable when a frontend on a different origin needs to call the API.

- **`CORS_ENABLED`** — `true` to enable. Default `false`.
- **`CORS_ORIGIN`** — `true` to reflect the request origin, `false` to disable, or a comma-separated list of allowed origins.
- **`CORS_METHODS`** — allowed methods. Default `GET,POST,PATCH,DELETE`.
- **`CORS_ALLOWED_HEADERS`** — allowed request headers. Default `Content-Type,Authorization`.
- **`CORS_EXPOSED_HEADERS`** — response headers exposed to the browser. Default `Content-Range`.
- **`CORS_CREDENTIALS`** — whether credentials (cookies, auth headers) can be included on cross-origin requests. Default `true`.
- **`CORS_MAX_AGE`** — preflight cache duration in seconds. Default `18000`.

## Rate limiting

Two independent rate limiters are available: per-IP and global. Both are off by default.

- **`RATE_LIMITER_ENABLED`** — per-IP limiter switch. Default `false`.
- **`RATE_LIMITER_POINTS`** — requests allowed per duration window. Default `50`.
- **`RATE_LIMITER_DURATION`** — window length in seconds. Default `1`.
- **`RATE_LIMITER_STORE`** — `memory` (single-process) or `redis` (distributed).
- **`RATE_LIMITER_GLOBAL_*`** — same shape, applied across all callers globally rather than per-IP.

For multi-instance deployments behind a load balancer, the `redis` store is required for the limit to be shared across processes.

## Caching

CairnCMS has two distinct caches:

- **Response caching** — caches the result of API requests. Off by default; turn on with `CACHE_ENABLED=true`.
- **Schema and permissions caching** — caches the internal schema model and permissions tables. On by default and runs even when response caching is disabled.

Variables for the response cache:

- **`CACHE_ENABLED`** — `true` to enable response caching. Default `false`.
- **`CACHE_STORE`** — `memory` or `redis`.
- **`CACHE_TTL`** — default cache duration. Default `5m`.
- **`CACHE_AUTO_PURGE`** — when `true`, the cache invalidates automatically on writes to relevant collections.

Variables for schema/permissions caching:

- **`CACHE_SCHEMA`** — cache the schema metadata. Default `true`.
- **`CACHE_PERMISSIONS`** — cache the permissions tables. Default `true`.

When using Redis, each subsystem has its own connection variable rather than a shared one:

- **`CACHE_REDIS`** — connection string for the response cache (or use `CACHE_REDIS_*` for nested config).
- **`RATE_LIMITER_REDIS`** — connection string for the rate limiter (or `RATE_LIMITER_REDIS_*`).
- **`MESSENGER_REDIS`** — connection string for the inter-process messenger (or `MESSENGER_REDIS_*`).

For multi-instance deployments, all three usually point at the same Redis but they are configured independently.

## Email

- **`EMAIL_FROM`** — sender address for all transactional emails. Required for any email feature.
- **`EMAIL_TRANSPORT`** — transport mechanism: `sendmail`, `smtp`, `mailgun`, or `ses`.
- **`EMAIL_VERIFY_SETUP`** — verify transport credentials at startup. Default `true`.

Per-transport settings live under `EMAIL_<TRANSPORT>_*`. For SMTP:

```bash
EMAIL_TRANSPORT="smtp"
EMAIL_SMTP_HOST="smtp.example.com"
EMAIL_SMTP_PORT="587"
EMAIL_SMTP_USER="..."
EMAIL_SMTP_PASSWORD="..."
EMAIL_SMTP_SECURE="false"
```

For email-template customization beyond transport configuration, see [Email templates](/docs/develop/email-templates/).

## Assets

Asset transformation settings:

- **`ASSETS_CACHE_TTL`** — how long transformed assets stay cached client-side. Default `30d`.
- **`ASSETS_TRANSFORM_MAX_CONCURRENT`** — concurrent transformation jobs. Default `25`.
- **`ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION`** — maximum side-length for transformed images. Default `6000`.
- **`ASSETS_TRANSFORM_MAX_OPERATIONS`** — chained operations per transform request. Default `5`.
- **`ASSETS_TRANSFORM_TIMEOUT`** — per-job timeout. Default `7500ms`.
- **`ASSETS_INVALID_IMAGE_SENSITIVITY_LEVEL`** — how strictly to reject corrupted images. `error`, `warning`, or `none`. Default `warning`.

## Extensions

- **`EXTENSIONS_PATH`** — root folder for local extensions, custom migrations, and email templates. Default `./extensions`.
- **`EXTENSIONS_AUTO_RELOAD`** — when `true`, the API watches extension files and reloads on change. Default `false`. Disabled in development; see the [Creating extensions](/docs/develop/extensions/creating-extensions/) page for the full caveat.
- **`PACKAGE_FILE_LOCATION`** — directory containing the project `package.json` (used to discover npm-installed extensions). Default `.`.

## Flows

The Run Script flow operation runs user-supplied JavaScript inside an isolated V8 sandbox without `require()` or host APIs. Two env vars govern the isolate's resource budget; one governs which environment variables the script can read.

- **`FLOWS_RUN_SCRIPT_MAX_MEMORY`** — memory limit for a single Run Script invocation, in MB. Default `32`. Scripts that exceed the limit are aborted.
- **`FLOWS_RUN_SCRIPT_TIMEOUT`** — wall-clock timeout for a single Run Script invocation, in milliseconds. Default `10000`. Scripts that exceed the limit are aborted.
- **`FLOWS_ENV_ALLOW_LIST`** — comma-separated list of environment variable names the Run Script operation is allowed to read via `process.env`. Default unset (no environment variables exposed to scripts).

## Resetting an admin password

If you lose access to an admin account, the CLI can set a new password directly:

```bash
cairncms users passwd --email admin@example.com --password new-strong-password
```

This bypasses the password policy and any 2FA enrollment on the user. The command runs against the configured database and updates the password hash in place.

For containerized deployments, run the command inside the running container:

```bash
docker compose --project-directory cairncms -f cairncms/docker-compose.yml \
  exec cairncms cairncms users passwd --email admin@example.com --password new-strong-password
```

If a user account is locked because of too many failed login attempts, an admin can unlock it by setting the user's `Status` to `Active` in the User Directory.

## The full reference

The variables above cover the most-tuned settings. For the complete list, including less-common transport options (Mailgun, AWS SES), per-vendor database tuning, telemetry-related variables that have been removed in CairnCMS, and other advanced settings, the canonical reference is the env-stub generated by `cairncms init` (at `api/src/cli/utils/create-env/env-stub.liquid` in the source tree). Everything CairnCMS reads from the environment is set with a default in `api/src/env.ts`.

## Where to go next

- [Deployment](/docs/manage/deployment/) covers running CairnCMS in production.
- [Security hardening](/docs/manage/security-hardening/) covers HTTPS, secrets management, and other production-safety configuration.
- [Auth](/docs/guides/auth/) covers SSO, two-factor, and session details that intersect with the auth-related variables above.
