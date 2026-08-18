---
title: Security hardening
description: Production-safety configuration for CairnCMS — TLS, secrets, authentication policy, rate limiting, and the Public role.
sidebar:
  order: 3
---

CairnCMS provides primitives like auth, permissions, rate limiting, IP allowlists, and hashed passwords, but the policy decisions belong to the operator. This page covers the production-safety choices that are not on by default and the configurations that are easy to overlook.

The goal here is not exhaustive security advice; it is a checklist of the platform-specific settings that need attention before a deployment goes live.

## TLS

The CairnCMS image does not terminate TLS. Run a reverse proxy (Caddy, Traefik, nginx) or a managed load balancer in front of it. Behind a proxy, set `IP_TRUST_PROXY` to that proxy's address so CairnCMS reads the real client IP from `X-Forwarded-For`. See [Trusted proxies and client IP](#trusted-proxies-and-client-ip).

For production over HTTPS, set the refresh-token cookie to be secure-only:

```bash
REFRESH_TOKEN_COOKIE_SECURE=true
```

The default (`false`) is tuned for local development and should be overridden in any internet-facing deployment. Without this, refresh-token cookies can travel over plain HTTP, undermining the session-security model.

`REFRESH_TOKEN_COOKIE_SAME_SITE` defaults to `lax` and is appropriate for most deployments. Tightening to `strict` adds extra protection against cross-site request forgery in some scenarios, but it can break legitimate flows where the app is reached from external links or cross-site auth handoffs. Treat `strict` as a stricter option to evaluate, not a default-on hardening step.

For cross-domain SSO setups, `SameSite=None` is required (and `Secure=true` is mandatory in that case). See [Auth](/docs/guides/auth/).

## Secrets

The platform requires two secret values:

- **`KEY`** — instance identifier. Surfaced as the service ID in server info and health-check responses. Not part of token signing.
- **`SECRET`** — random secret used to sign access and refresh tokens. Treat as a credential. Changing it invalidates every existing token, so rotate deliberately.

A third becomes required once extensions or flows store secrets:

- **`SECRETS_ENCRYPTION_KEY`** — key under which inline extension secrets and secret flow-operation options are encrypted at rest. Canonical base64 decoding to at least 32 bytes (`openssl rand -base64 32`); a malformed value fails startup. Deliberately separate from `SECRET`, so rotating the token-signing secret never affects stored encrypted data. Changing this key makes previously stored secret values unreadable: they fail closed and must be re-entered.

Plus the database password, any SSO provider client secrets, any storage backend credentials, any SMTP password, any `CAIRNCMS_EXT_*` extension secrets provisioned through deployment config, and any static tokens generated for service accounts.

For production:

- Source secrets from a secret manager (your platform's offering, HashiCorp Vault, AWS Secrets Manager, GCP Secret Manager, etc.) rather than from a `.env` file checked into source control.
- Rotate `SECRET` carefully. Rotation invalidates every existing session. Sometimes that is the goal (compromise response), other times it is a surprise outage.
- Rotate static tokens by clearing the user's token field and reissuing.
- Never commit `.env` files containing real values.

## The Public role

The Public role applies to every unauthenticated request. By default it has no permissions; anything you add to it is granted to the entire internet.

Default discipline:

- Leave Public with no write permissions. There is essentially no legitimate reason for an unauthenticated request to create, update, or delete records on a public-facing CairnCMS instance. Spam and abuse are the certain outcome.
- For collections that need public read access, use **custom permissions** to scope which items and which fields are returned. A typical pattern: filter to `status: published` and restrict the field list to fields safe for public consumption.
- Audit the Public role periodically. It is the single most consequential surface in the permissions model.

For collections where any anonymous interaction is needed (a public form, a contact endpoint), prefer a flow with a Webhook trigger over a public-write Public-role permission. The flow can validate inputs before touching collection data.

## Admin access

Admin access bypasses every permission check. Reserve it for the small number of people who actually administrate the platform.

- Treat admin access as a flag, not a role. A "marketing admin" who only edits content does not need admin access. Give them a custom role with the permissions they actually use.
- Audit who has admin access regularly. A user who needed admin during initial setup should not still have it six months later.
- Never give admin access to a service-account static token unless that token genuinely needs full unrestricted access. Most service accounts are better off with a scoped role and a static token tied to it.

CairnCMS enforces that at least one admin role must always exist, but it does not stop you from having too many admins.

## Two-factor authentication

CairnCMS supports TOTP-based two-factor authentication. It is opt-in per user by default. For production:

- Enable **Enforce 2FA** on every role with elevated privileges (admin roles especially, but also any role with broad write or delete permissions). Users in that role cannot log in until they enroll.
- Enroll all admin users yourself before pushing 2FA enforcement to other roles, to make sure the rollout does not lock anyone out.

See [Auth](/docs/guides/auth/) for the user enrollment flow.

## Password policy

Set the password complexity policy in **Settings > Project Settings > Security**:

- **None** — no complexity requirement (the default).
- **Weak** — 8-character minimum.
- **Strong** — uppercase, lowercase, numbers, and special characters.
- **Other** — custom regex.

Strong is the recommended production baseline. The custom-regex option exists for organizations with specific compliance requirements (NIST 800-63B, ISO 27001-aligned policies, and so on).

## Account lockout and login throttling

These settings are independent of the password policy and form a separate account-protection layer:

- **Auth Login Attempts** — number of failed logins before the account is automatically locked. Default `25`. Configured under **Settings > Project Settings > Security**. Locked accounts must be reactivated by an admin (set the user's status back to Active in the User Directory).
- **`LOGIN_STALL_TIME`** — milliseconds the platform waits before responding to a failed login. Default `500`. Mitigates timing attacks against the login endpoint; do not lower it.

## Trusted proxies and client IP

Rate limiting, IP allowlists, audit records, and login records all key on the client IP CairnCMS derives for each request. That IP is only trustworthy if CairnCMS knows which upstream proxies may report it.

`IP_TRUST_PROXY` defaults to `false`, meaning CairnCMS trusts no proxy and reads the immediate connection's address. A directly exposed instance is correct out of the box: a client cannot claim a different IP by sending `X-Forwarded-For`.

Behind a reverse proxy or load balancer, set `IP_TRUST_PROXY` to that proxy's exact address or subnet (for example `10.0.0.5/32`), a comma-separated list, or `loopback` for a same-host proxy. CairnCMS then reads the forwarded client IP only when the immediate peer is in that trusted set. Do not set a broad range you do not control.

Avoid `true` (trust every hop). It is safe only if every ingress in front of CairnCMS strips or overwrites client-supplied `X-Forwarded-For` and related headers, so a value the client sent cannot survive to CairnCMS. Blocking direct network access to the API is not sufficient on its own, because a request that reaches CairnCMS through the proxy still carries whatever forwarding headers the client set unless the proxy rewrites them.

`IP_CUSTOM_HEADER` names an alternative header for the client IP. It is honored only from a trusted immediate peer under the same rule, so a direct client cannot use it to spoof.

## IP allowlists

Each role can restrict access to specific source IPs. Set **IP Access** on the role to a comma-separated list of allowed addresses. The check runs on every authenticated request, not just login.

Two important constraints:

- The match is exact string comparison. CIDR ranges are not supported. List each address explicitly.
- The check applies *after* authentication, not before. A caller still proves their identity first; IP restrictions then determine whether their session is allowed to act.

IP allowlists are most useful for tightly scoped admin or service accounts whose legitimate caller comes from a known network, such as a CI worker, a backup script, a corporate VPN range.

## Rate limiting

Rate limiting is off by default. Turn it on for any internet-facing deployment:

```bash
RATE_LIMITER_ENABLED=true
RATE_LIMITER_POINTS=50
RATE_LIMITER_DURATION=1
RATE_LIMITER_STORE=redis  # for multi-instance deployments
```

Two layers are available:

- **Per-IP rate limiter** (`RATE_LIMITER_*`) — caps requests per IP per window. Stops casual abuse.
- **Global rate limiter** (`RATE_LIMITER_GLOBAL_*`) — caps total requests across all callers. Stops aggregate load from outpacing your infrastructure.

For a multi-instance deployment behind a load balancer, the `redis` store is required so limits are shared. Without it, each instance limits independently and the actual cap is `<configured-cap> × <instance count>`.

## CORS

CORS is off by default. Enable it only when a frontend on a different origin needs to call the API:

```bash
CORS_ENABLED=true
CORS_ORIGIN=https://app.example.com
CORS_CREDENTIALS=true
```

Avoid `CORS_ORIGIN=true` (reflects the request origin) in production. List exact origins instead. The reflective default is convenient for development and dangerous for production — it lets any origin send authenticated cross-origin requests.

When `CORS_CREDENTIALS=true`, the browser sends auth cookies on cross-origin requests; the response's `Access-Control-Allow-Origin` cannot be `*` in that case (the browser refuses), so the explicit origin list is doing real work.

## Email-link allow lists

Password reset and user invitation flows accept an optional caller-supplied return URL for the link the recipient clicks to complete the action. When a custom URL is supplied, CairnCMS validates it against an allow list:

```bash
PASSWORD_RESET_URL_ALLOW_LIST=https://app.example.com/reset
USER_INVITE_URL_ALLOW_LIST=https://app.example.com/invite
```

If no custom URL is supplied, the flow falls back to a default URL constructed from `PUBLIC_URL` (`<PUBLIC_URL>/admin/reset-password` for resets, the equivalent invitation path for invites). The default flow works without any allow-list configuration.

The allow list only gates caller-supplied URLs. Configure it whenever your frontend triggers password resets or invitations and passes its own return URL. Without an allow list, an attacker who can call the reset endpoint could redirect the recipient to a malicious site after the action completes.

## Static tokens

Static tokens are long-lived and never expire. Treat them like passwords:

- Store them in your secret manager, not in source control.
- Scope them to a service account with a narrow role, not to an admin user.
- Rotate periodically. Rotation requires regenerating the user's token field; the old token is invalid the moment the new one is set.
- Audit which static tokens exist regularly. A token tied to a deprecated integration is an unnecessary credential left active.

For interactive users (a person logging in through the app), prefer the access/refresh-token flow over static tokens. Refresh tokens have built-in expiry and rotation; static tokens have neither.

## File-relation deletion behavior

By default, deleting a file with a relation field set to `SET NULL` (the default) clears the references. The related items continue to exist with a null file pointer. This is permissive: it does not block file deletion when something still references the file.

For projects where files are critical (legal documents, audit trails, anything that should not silently disappear from related records), change the relation's `On Delete` to `RESTRICT` or `NO ACTION` so file deletion is blocked while references exist. See [Files](/docs/guides/files/) for the configuration UI.

## File-import SSRF hardening

`POST /files/import` lets the server fetch a URL and store the bytes as a new file. Because the request is issued by the server, it can potentially reach internal services unreachable from the original caller. The platform validates the resolved IP of every URL import against a deny list before opening the connection.

The default deny list blocks:

- loopback ranges (`127.0.0.0/8` and IPv6 `::1`),
- any IP bound to one of the host's own network interfaces,
- the EC2 / cloud metadata endpoint at `169.254.169.254`.

Imports that resolve to a denied IP fail at the outbound connection step and return `503 SERVICE_UNAVAILABLE` with a body indicating the import URL could not be fetched. Operators can extend the deny list with `IMPORT_IP_DENY_LIST` (comma-separated exact IPs; CIDR is not supported). See [Configuration](/docs/manage/configuration/) for the exact behavior, including the special meaning of `0.0.0.0`.

## Database

- **Use TLS to the database** if it travels outside your trusted network. Configure `DB_SSL__*` variables to require encryption and validate certificates.
- **Use a dedicated database user** with only the privileges CairnCMS needs (CREATE, ALTER, INDEX on its own tables; SELECT/INSERT/UPDATE/DELETE on data). Avoid running CairnCMS as the database superuser.
- **For MySQL/MariaDB, set the connection charset to `utf8mb4`** to prevent silent truncation of UTF-8 characters that take more than 3 bytes (most CJK, all emoji). See [Configuration](/docs/manage/configuration/).

## Logging and accountability

Two surfaces help when investigating an incident:

- The **activity log** records create, update, delete, comment, and login events with the actor, timestamp, IP, and user-agent. Reached through the **Activity Log** button at the bottom of the sidebar. Activity is its own module, not a Settings page.
- The **server log** captures process-level information through Pino. Forward it to a centralized log destination so it survives container restarts.

The following platform sinks apply redaction:

- **HTTP request logs (pino-http)** redact the `Authorization` request header, the `Cookie` request header, the `access_token` query parameter, and the `Set-Cookie` response header before writing the log line.
- **Flow revision data** (written when a flow's `accountability` is `all`) redacts values associated with a known set of secret-bearing keys, values that originate from those keys and propagate into later operation options, and the deployment values a flow can read through `FLOWS_ENV_ALLOW_LIST`.
- **Flow log output** from the Log to Console and Run Script operations redacts the same secrets before writing to the server log, so a secret referenced in a log message or printed with `console.*` is replaced rather than logged in cleartext.
- **REST and GraphQL error output** redacts the values CairnCMS identifies as secrets from error responses and their server logs. Detection matches recognized sensitive keys, and it propagates the recognized secret values found in the REST request context, in GraphQL variables, and in an error's cause chain, so those values are replaced wherever they reappear in a message or stack.

Values exposed to a flow through `FLOWS_ENV_ALLOW_LIST` are treated as confidential in both platform logs and revisions. Allowlisting a deployment variable lets a flow read it, but it does not consent to persisting that value in a log. Redaction covers scalar string and numeric values and the string and numeric leaves of `json:` and `array:` values, so a non-secret allowlisted value is redacted too. It does not cover booleans, whitespace-only strings, or the contents of non-data objects that a JavaScript config file can expose.

Redaction targets secrets, not arbitrary PII, and matches a secret by its key or its value, including common encoded forms of the value. A secret that a flow derives into a new value before logging, such as a hash or a substring, no longer matches and is not redacted. SQL query tracing, which runs only at the `trace` log level, still writes raw query bindings. Treat trace-level logs as debug-only and keep secret values out of them.

For audit-heavy projects, leave activity logging on (the default) and configure the role's accountability tracking to include revisions, not just activity. Revisions let you reconstruct an item's full history; activity records what happened.

## Extensions

Extensions run third-party code inside the platform, so the security model depends on which runtime an extension uses. The [extension docs](/docs/develop/extensions/) cover the runtimes in full. The operator-facing summary:

- **App extensions** run in the admin browser under the logged-in user's own permissions. They are not a security boundary, so treat an installed app extension as code you trust with that user's session.
- **Full-authority server extensions** run in the API process with full access to services, the database, and the environment. They are unconfined. Install only what you are willing to run with that reach.
- **Confined server extensions** run sandboxed. This is the boundary that lets you run a server extension without granting it the API process.

### The confined sandbox

A confined server extension runs in a QuickJS engine with no host imports, no Node, no `fetch`, and no filesystem. Every privileged effect goes through a brokered `host.*` call gated by the capabilities and settings the extension declares in its manifest, so what an extension can reach is visible and bounded before it runs.

The platform adds OS-level hardening around the sandbox child process where the host supports it: a network namespace, the Node permission model with a scoped read, and a cgroup memory cap. `EXTENSIONS_SANDBOX_OS_HARDENING` governs how strictly these are enforced. Under `auto`, the default, they are best-effort and never block an extension, because the engine boundary already contains the guest. Under `required`, the runtime refuses to start a confined extension on a host that cannot provide the escape-containment core (the network namespace and the Node permission model). See the [Sandbox](/docs/develop/extensions/server-extensions/sandbox/) reference for the runtime model and [Configuration](/docs/manage/configuration/) for the sandbox variables.

### Review the items capability at install time

The `items` capability permits reads and writes. Review its accountability mode in **Settings > Extensions** before installing:

- `user` enforces the invocation's role permissions. Prefer this mode.
- `full-access` bypasses role permissions on user collections, for reads and writes. Treat it as you would a flow configured with Full Access.

Top-level system and internal collections remain unavailable in both modes. When a collection records activity, full-access writes use a null user. Where user attribution matters, use `user` mode with a dedicated service user.

### App extension egress

An app extension runs in the admin browser, so its outbound network access is governed by the admin app's Content Security Policy, not by the sandbox. The default `connect-src` is limited to first-party (`'self'`) plus the built-in map origins, with no external wildcard. An app extension that tries to fetch an external CDN or third-party API directly from the browser is blocked by that policy.

The supported pattern is to route external data through a same-origin endpoint. A confined endpoint, or a bundle's confined endpoint entry, fetches the external API server-side under its declared `request` origins, and the app extension calls that endpoint on its own origin. If an operator genuinely needs the browser to reach a specific external origin, they can set `CONTENT_SECURITY_POLICY_DIRECTIVES__CONNECT_SRC`, which fully replaces the default list. See [Configuration](/docs/manage/configuration/).

## Where to go next

- [Configuration](/docs/manage/configuration/) is the reference for every environment variable mentioned here.
- [Auth](/docs/guides/auth/) covers SSO, two-factor enrollment, and session details.
- [Permissions](/docs/guides/permissions/) covers the role and permission system the Public role and admin access flag belong to.
- [Backups](/docs/manage/backups/) covers the backup-and-recovery side of operational safety.
