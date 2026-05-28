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

The merge order is: built-in defaults, then `process.env`, then the config file. The config file is applied last and therefore wins for any key it defines. To let a value from `process.env` take effect, leave the key out of the file. This is the inverse of the 12-factor convention; it lets a checked-in config file remain authoritative without operators needing to remember which env vars the host might have set.

The `cairncms init` scaffold writes a starter `.env` to `cairncms/.env` with random secrets and a default admin password. Operators usually edit that file before first deploy and source-control everything except secret values.

For Docker deployments, the same variables come from the `environment:` block of the Compose service or from a referenced env file. Treat the values as secrets. Never commit a `.env` file with real credentials to source control.

## Type casting

Most environment variables are auto-coerced based on a known internal type map: `PORT` is read as a number, `DB_NAME` as a string, `RATE_LIMITER_ENABLED` as a boolean, and so on. For variables that aren't in the type map, CairnCMS infers the type from the value (`"true"`/`"false"` to boolean, numeric strings to numbers, JSON-shaped strings to objects).

To force a specific type, prefix the value with the type name and a colon:

```bash
DB_PASSWORD="string:1234567890"
CACHE_TTL="string:5m"
DB_EXCLUDE_TABLES="array:spatial_ref_sys,sysdiagrams"
```

Recognized prefixes: `string`, `number`, `regex`, `array`, `json`. There is no `boolean:` prefix; for boolean-typed variables, the auto-inference of `"true"` / `"false"` is sufficient. Use a prefix when the inferred type would be wrong, for example, when a numeric-looking password should stay a string.

## Server

Variables that control how CairnCMS listens for requests:

- **`HOST`** — interface to bind. Default `0.0.0.0`.
- **`PORT`** — port to listen on. Default `8055`.
- **`PUBLIC_URL`** — the externally-reachable URL of the instance. Used to construct asset URLs, redirect targets, and email links. Set this whenever the instance is reachable through a hostname or path that isn't `http://localhost:8055`.
- **`SERVE_APP`** — whether to serve the admin app at `/admin`. Default `true`. Set to `false` for headless API deployments where no operator UI is needed.
- **`GRAPHQL_INTROSPECTION`** — whether the GraphQL schema is introspectable. Default `true`. Disable in production if you do not want unauthenticated clients to enumerate the schema.
- **`MAX_PAYLOAD_SIZE`** — the maximum request body size. Default `1mb`. Increase when receiving large uploads or imports.
- **`MAX_RELATIONAL_DEPTH`** — how deeply nested a single query can fetch related data. Default `10`.
- **`MAX_BATCH_MUTATION`** — limit on items in a batch create/update/delete. Default unlimited.
- **`QUERYSTRING_PARSE_DEPTH`** — maximum nesting depth parsed from URL query strings. Default `10`.
- **`QUERYSTRING_ARRAY_LIMIT`** — maximum number of indexed query-string array entries parsed as arrays. Default `500`. Raise this if clients send large indexed arrays such as wide `_in` filters. Lower values reduce query parsing resource exposure.
- **`ROBOTS_TXT`** — the body served at `/robots.txt`. Default disallows all crawlers.
- **`ROOT_REDIRECT`** — where requests to `/` redirect. Default `./admin`.
- **`SERVER_SHUTDOWN_TIMEOUT`** — milliseconds to wait for in-flight requests during shutdown. Default `1000`.
- **`IP_TRUST_PROXY`** — whether Express should trust `X-Forwarded-For` headers. Default `true` (assumes a reverse proxy in front).
- **`IP_CUSTOM_HEADER`** — alternative header to read the client IP from, when not using `X-Forwarded-For`.

## Logging

CairnCMS uses pino for structured logging.

- **`LOG_LEVEL`** — `fatal`, `error`, `warn`, `info`, `debug`, `trace`, or `silent`. Default `info`. Use `debug` or `trace` for verbose request and operation traces.
- **`LOG_STYLE`** — `pretty` (default, human-readable) or `raw` (line-delimited JSON, suitable for log shippers and aggregation systems).

Additional `LOGGER_*` variables pass through to the underlying pino logger options, and `LOGGER_HTTP_*` variables pass through to the HTTP request logger. Use these for tuning that is not exposed at the top level (e.g., custom serializers, redaction paths, request/response shape filtering).

## Database

CairnCMS supports SQLite, PostgreSQL, MySQL, MariaDB. The connection is configured through:

- **`DB_CLIENT`** — `sqlite3` for SQLite, `pg` for PostgreSQL, `mysql` for both MySQL and MariaDB. MariaDB does not have a separate client value; it shares MySQL's underlying driver.
- **`DB_HOST`** / **`DB_PORT`** / **`DB_DATABASE`** / **`DB_USER`** / **`DB_PASSWORD`** — connection details for server-based databases.
- **`DB_FILENAME`** — path to the SQLite database file. SQLite-only.
- **`DB_SSL__*`** / **`DB_POOL__*`** — SSL options and connection pool tuning. Use the double-underscore syntax to express nested config (`DB_SSL__REJECT_UNAUTHORIZED=false`, `DB_POOL__MIN=2`). Any key in the `DB_*` prefix passes through to the underlying Knex connection object.
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

For Google Cloud Storage:

```bash
STORAGE_LOCATIONS="gcs"
STORAGE_GCS_DRIVER="gcs"
STORAGE_GCS_KEY_FILENAME="/path/to/service-account.json"
STORAGE_GCS_BUCKET="..."
```

For Azure Blob Storage:

```bash
STORAGE_LOCATIONS="azure"
STORAGE_AZURE_DRIVER="azure"
STORAGE_AZURE_CONTAINER_NAME="..."
STORAGE_AZURE_ACCOUNT_NAME="..."
STORAGE_AZURE_ACCOUNT_KEY="..."
```

For Cloudinary:

```bash
STORAGE_LOCATIONS="cloudinary"
STORAGE_CLOUDINARY_DRIVER="cloudinary"
STORAGE_CLOUDINARY_CLOUD_NAME="..."
STORAGE_CLOUDINARY_API_KEY="..."
STORAGE_CLOUDINARY_API_SECRET="..."
```

Any `STORAGE_<LOCATION>_*` key beyond the named ones above passes through to the driver. ACL settings, server-side encryption options, health-check thresholds, and other driver-specific knobs are all set this way.

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
- **`AUTH_PROVIDERS`** — comma-separated list of SSO providers to enable.
- **`AUTH_DISABLE_DEFAULT`** — when `true`, the built-in email/password login is disabled and only configured SSO providers can authenticate.

Per-provider configuration uses the pattern `AUTH_<PROVIDER>_*`. For example, `AUTH_GOOGLE_DRIVER=openid` declares an OpenID Connect provider named `google`, and subsequent `AUTH_GOOGLE_CLIENT_ID`, `AUTH_GOOGLE_CLIENT_SECRET`, and other driver-specific variables configure the connection. The driver-specific variable shape passes through to the underlying library (Passport strategies for OAuth2 and OpenID, ldapjs for LDAP, samlify for SAML). See the [Auth](/docs/guides/auth/) guide for setup examples across the common providers.

Password hashing options are passed through to argon2 via `HASH_*` variables (e.g., `HASH_MEMORY_COST`, `HASH_TIME_COST`, `HASH_PARALLELISM`). Defaults match argon2id recommendations; only override if you have measured the impact on login latency.

## Bootstrap

These variables seed the initial admin user when `cairncms bootstrap` runs against an empty database. After bootstrap they have no effect, but the values typically stay in `.env` so a reproducible re-bootstrap (against a fresh database) yields the same admin.

- **`ADMIN_EMAIL`** — email for the initial admin account.
- **`ADMIN_PASSWORD`** — password for the initial admin account.

If either is unset, `cairncms bootstrap` prompts interactively for both.

## Security headers

CairnCMS sets standard security response headers via Helmet. Most can be tuned per deployment.

- **`HSTS_ENABLED`** — emit the `Strict-Transport-Security` header. Default `false`. Enable in production when serving over HTTPS.
- **`HSTS_*`** — pass-through to Helmet's HSTS options (`HSTS_MAX_AGE`, `HSTS_INCLUDE_SUBDOMAINS`, `HSTS_PRELOAD`).
- **`CONTENT_SECURITY_POLICY_*`** — pass-through to Helmet's CSP option shape. The default CSP allows the admin app to load its own assets and connect to the API origin.
- **`ASSETS_CONTENT_SECURITY_POLICY`** — separate CSP applied only to `/assets/*` responses. Useful when serving user-uploaded content with a stricter policy than the rest of the API.
- **`IMPORT_IP_DENY_LIST`** — comma-separated exact IP addresses blocked from URL imports (SSRF defense). Matches are literal string comparisons; CIDR notation is not supported. Default blocks `0.0.0.0` and the EC2/cloud metadata endpoint `169.254.169.254`. The `0.0.0.0` entry has a special meaning: when present, all loopback addresses and any address bound to the host's own network interfaces are also blocked. To block other addresses, list each one explicitly.

For the full Helmet option shape, see the Helmet documentation.

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

Three independent rate limiters are available: per-IP, global, and pressure-based. All three are off by default.

- **`RATE_LIMITER_ENABLED`** — per-IP limiter switch. Default `false`.
- **`RATE_LIMITER_POINTS`** — requests allowed per duration window. Default `50`.
- **`RATE_LIMITER_DURATION`** — window length in seconds. Default `1`.
- **`RATE_LIMITER_STORE`** — `memory` (single-process), `redis` (distributed), or `memcache`.
- **`RATE_LIMITER_GLOBAL_*`** — same shape, applied across all callers globally rather than per-IP.

For multi-instance deployments behind a load balancer, the `redis` store is required for the limit to be shared across processes. Per-store details (Redis connection settings, healthcheck thresholds) live under `RATE_LIMITER_*_REDIS`, `RATE_LIMITER_*_MEMCACHE`, and `RATE_LIMITER_*_HEALTHCHECK_THRESHOLD`. Both the per-IP and global limiters accept the same option set under their respective prefixes.

### Pressure-based limiter

A third limiter monitors Node event-loop and memory pressure and returns `503 Service Unavailable` when the process is overloaded. The goal is to give load balancers a fast failure signal under genuine saturation rather than letting requests queue behind an unresponsive server.

- **`PRESSURE_LIMITER_ENABLED`**: pressure limiter switch. Default `false`.
- **`PRESSURE_LIMITER_SAMPLE_INTERVAL`**: sampling cadence in milliseconds. Default `250`.
- **`PRESSURE_LIMITER_MAX_EVENT_LOOP_UTILIZATION`**: fraction of event-loop utilization above which the process is considered overloaded. Default `0.99`.
- **`PRESSURE_LIMITER_MAX_EVENT_LOOP_DELAY`**: maximum event-loop delay in milliseconds. Default `500`.
- **`PRESSURE_LIMITER_MAX_MEMORY_RSS`**: maximum process resident set size in bytes. Default `false` (disabled).
- **`PRESSURE_LIMITER_MAX_MEMORY_HEAP_USED`**: maximum heap-used memory in bytes. Default `false` (disabled).
- **`PRESSURE_LIMITER_RETRY_AFTER`**: value sent in the `Retry-After` response header on 503 responses. Default `false` (header is not set).

The CairnCMS default is opt-in. Pressure limiting is the most workload-sensitive of the three rate limiters. Long-running queries, imports, exports, image transforms, ETL jobs, and deployments on small container CPU limits can briefly saturate the event loop or RSS without the process actually being in trouble. Dry-run against a representative workload before enabling.

The limiter is per Node process. In multi-instance deployments (Cloud Run, Kubernetes, multi-container Compose), each container monitors its own pressure independently. The middleware does not coordinate across instances and does not signal readiness or liveness failure to the orchestrator. A 503 from this limiter tells the immediate caller to retry. It does not remove the instance from the load balancer rotation.

## Caching

CairnCMS has two distinct caches:

- **Response caching** — caches the result of API requests. Off by default; turn on with `CACHE_ENABLED=true`.
- **Schema and permissions caching** — caches the internal schema model and permissions tables. On by default and runs even when response caching is disabled.

Variables for the response cache:

- **`CACHE_ENABLED`** — `true` to enable response caching. Default `false`.
- **`CACHE_STORE`** — `memory`, `redis`, or `memcache`.
- **`CACHE_TTL`** — default cache duration. Default `5m`.
- **`CACHE_AUTO_PURGE`** — when `true`, the cache invalidates automatically on writes to relevant collections.
- **`CACHE_CONTROL_S_MAXAGE`** — value for the `Cache-Control: s-maxage` directive on cached responses, in seconds. Default `0`.
- **`CACHE_STATUS_HEADER`** — name of the response header indicating cache hit/miss. Unset by default (no header emitted).
- **`CACHE_VALUE_MAX_SIZE`** — maximum size in bytes for a cacheable response. Larger responses bypass the cache. Default `false` (no limit).
- **`CACHE_SKIP_ALLOWED`** — when `true`, callers can bypass the cache by sending a `Cache-Control: no-store` request header. Default `false`.
- **`CACHE_HEALTHCHECK_THRESHOLD`** — latency threshold in milliseconds; the cache is reported unhealthy when its operations exceed this. Defaults to `150` ms when unset.

Variables for the system (schema/permissions) cache:

- **`CACHE_SCHEMA`** — cache the schema metadata. Default `true`.
- **`CACHE_PERMISSIONS`** — cache the permissions tables. Default `true`.
- **`CACHE_SYSTEM_TTL`** — TTL for the schema and permissions cache. Unset by default (cache lives for the process lifetime, invalidated on schema or permission writes).
- **`CACHE_NAMESPACE`** — Redis key prefix. Default `system-cache`. Set per-instance when multiple CairnCMS deployments share the same Redis.

When using Redis, each subsystem has its own connection variable rather than a shared one:

- **`CACHE_REDIS`** — connection string for the response cache.
- **`CACHE_REDIS_HOST` / `CACHE_REDIS_PORT` / `CACHE_REDIS_PASSWORD`** — broken-out fields, used as an alternative to `CACHE_REDIS`.
- **`RATE_LIMITER_REDIS`** — connection string for the rate limiter.

For multi-instance deployments, the cache, rate limiter, and messenger Redis usually point at the same instance but are configured independently so a deployment can split them apart if needed.

## Messenger

The messenger is the inter-process communication layer that broadcasts events like cache invalidations across CairnCMS instances. Single-instance deployments use the in-memory store; horizontally-scaled deployments need Redis.

- **`MESSENGER_STORE`** — `local` (single-process) or `redis` (multi-instance). Default `local`.
- **`MESSENGER_NAMESPACE`** — Redis pub/sub channel prefix. Default `cairncms`.
- **`MESSENGER_REDIS`** — connection string for the messenger Redis.
- **`MESSENGER_REDIS_HOST` / `MESSENGER_REDIS_PORT` / `MESSENGER_REDIS_PASSWORD`** — broken-out fields, used as an alternative to `MESSENGER_REDIS`.

## Email

- **`EMAIL_FROM`** — sender address for all transactional emails. Required for any email feature.
- **`EMAIL_TRANSPORT`** — transport mechanism: `sendmail`, `smtp`, `mailgun`, `sendgrid`, or `ses`. Default `sendmail`.
- **`EMAIL_VERIFY_SETUP`** — verify transport credentials at startup. Default `true`.

Per-transport settings live under `EMAIL_<TRANSPORT>_*`.

For SMTP:

```bash
EMAIL_TRANSPORT="smtp"
EMAIL_SMTP_HOST="smtp.example.com"
EMAIL_SMTP_PORT="587"
EMAIL_SMTP_USER="..."
EMAIL_SMTP_PASSWORD="..."
EMAIL_SMTP_SECURE="false"
```

Additional `EMAIL_SMTP_*` keys (such as `EMAIL_SMTP_NAME`, `EMAIL_SMTP_POOL`, `EMAIL_SMTP_IGNORE_TLS`, and the `EMAIL_SMTP_TLS_*` family) pass through to nodemailer's SMTP transport options.

For sendmail (default):

```bash
EMAIL_TRANSPORT="sendmail"
EMAIL_SENDMAIL_PATH="/usr/sbin/sendmail"
EMAIL_SENDMAIL_NEW_LINE="unix"
```

For Mailgun:

```bash
EMAIL_TRANSPORT="mailgun"
EMAIL_MAILGUN_API_KEY="..."
EMAIL_MAILGUN_DOMAIN="mg.example.com"
EMAIL_MAILGUN_HOST="api.mailgun.net"
```

`EMAIL_MAILGUN_HOST` defaults to `api.mailgun.net`; override to `api.eu.mailgun.net` for EU-region accounts.

For SendGrid:

```bash
EMAIL_TRANSPORT="sendgrid"
EMAIL_SENDGRID_API_KEY="..."
```

For Amazon SES:

```bash
EMAIL_TRANSPORT="ses"
EMAIL_SES_CREDENTIALS__ACCESS_KEY_ID="..."
EMAIL_SES_CREDENTIALS__SECRET_ACCESS_KEY="..."
EMAIL_SES_REGION="us-east-1"
```

`EMAIL_SES_*` variables pass through to the AWS SDK v3 SESv2 client configuration. Use the double-underscore syntax for nested fields.

For email-template customization beyond transport configuration, see [Email templates](/docs/develop/email-templates/).

## Assets

Asset transformation settings:

- **`ASSETS_CACHE_TTL`** — how long transformed assets stay cached client-side. Default `30d`.
- **`ASSETS_TRANSFORM_MAX_CONCURRENT`** — concurrent transformation jobs. Default `25`.
- **`ASSETS_TRANSFORM_IMAGE_MAX_DIMENSION`** — maximum side-length for transformed images. Default `6000`.
- **`ASSETS_TRANSFORM_MAX_OPERATIONS`** — chained operations per transform request. Default `5`.
- **`ASSETS_TRANSFORM_TIMEOUT`** — per-job timeout. Default `7500ms`.
- **`ASSETS_INVALID_IMAGE_SENSITIVITY_LEVEL`** — how strictly to reject corrupted images. `error`, `warning`, or `none`. Default `warning`.

## Files and batch operations

- **`FILE_METADATA_ALLOW_LIST`** — comma-separated list of EXIF and IFD tag paths to extract from uploaded image files. Default includes camera make, model, F-number, exposure, focal length, and ISO. Restrict further or expand depending on your privacy and metadata-display requirements.
- **`RELATIONAL_BATCH_SIZE`** — chunk size for batched relational queries. Default `25000`. Larger values reduce round trips at the cost of memory; smaller values trade more queries for lower memory use.
- **`EXPORT_BATCH_SIZE`** — chunk size for streaming exports. Default `5000`. Tunes memory pressure on large exports.

## Extensions

- **`EXTENSIONS_PATH`** — root folder for local extensions, custom migrations, and email templates. Default `./extensions`.
- **`EXTENSIONS_AUTO_RELOAD`** — when `true`, the API watches extension files and reloads on change. Default `false`. Disabled in development; see the [Creating extensions](/docs/develop/extensions/creating-extensions/) page for the full caveat.
- **`EXTENSIONS_CACHE_TTL`** — `Cache-Control` max-age applied to the `/extensions/*` bundle responses. Unset by default (no client cache).
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

## Where to go next

- [Deployment](/docs/manage/deployment/) covers running CairnCMS in production.
- [Security hardening](/docs/manage/security-hardening/) covers HTTPS, secrets management, and other production-safety configuration.
- [Auth](/docs/guides/auth/) covers SSO, two-factor, and session details that intersect with the auth-related variables above.
